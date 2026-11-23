// 화면 전용 HTTP 서버(view 설계 §6.1). 채널 파일을 직접 읽고 허브에는 접속 세션만 묻는다.
// 공개 코드라 허브를 정적으로 import 하지 않는다 — 허브 클라이언트는 makeHubSessionsFetcher 안에서만
// 쓰는 순간에 불러온다(공개 미러에는 src/hub 가 없다, src/setup/run-setup.js 와 같은 방식).
// 읽는 것은 `<home>/channels/plp-*.json` 과 `<home>/view.json` 뿐이다 — workers/·logs/·agents.json·
// config.json 은 열지 않는다(반목표: 워커 로그 노출).
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot, viewChannel, isActiveAt } from "./model.js";
import {
  readViewLock,
  writeViewLock,
  removeViewLockIf,
  KEY_HEADER,
} from "../shared/view-lock.js";
import { PACKAGE_VERSION } from "../shared/version.js";

/** 채널 폴더 훑기 주기 */
export const POLL_MS = 1000;
/** hub.sessions 조회 주기(허브가 응답마다 모든 채널 파일을 읽으므로 자주 묻지 않는다) */
export const SESSIONS_POLL_MS = 5000;
/** 열린 스트림이 하나도 없는 채로 이만큼 지나면 스스로 끈다(30분) */
export const IDLE_MS = 1_800_000;
/** 데이터 요청의 키 헤더(Node 는 헤더 이름을 소문자로 준다) */
export { KEY_HEADER };

/** 스트림이 끊기지 않게 보내는 주석 줄 주기 */
const STREAM_PING_MS = 15_000;
/** 다른 화면 서버의 /health 를 기다리는 상한 */
const HEALTH_TIMEOUT_MS = 1000;
/** 스냅샷이 아직 진행 중인 첫 hub.sessions 조회를 기다리는 상한(그 뒤엔 아는 것으로 — 허브 꺼짐) */
export const FIRST_SESSIONS_WAIT_MS = 1500;
/** hub.sessions 가 있는 최소 프로토콜(Plan 6c) */
const SESSIONS_MIN_PROTOCOL = 11;
const CHANNEL_FILE = /^plp-[a-z0-9]{4}-[a-z0-9]{4}\.json$/;

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

const JS = "text/javascript; charset=utf-8";
/** 정적 경로 → [static/ 아래 파일, Content-Type]. 여기 없는 경로는 404(경로 조합을 하지 않는다). */
const STATIC = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", JS]],
  ["/markdown.js", ["markdown.js", JS]],
  ["/reconnect.js", ["reconnect.js", JS]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
]);
const STATIC_DIR = new URL("./static/", import.meta.url);
const KEYED = new Set(["/api/snapshot", "/api/events", "/health"]);

/** 상수 시간 키 비교. 길이가 다르면 바로 거짓(키 길이는 비밀이 아니다). */
function keyMatches(given, key) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, body, type = "text/plain; charset=utf-8", head) {
  res.writeHead(status, { "Content-Type": type });
  res.end(head ? undefined : body);
}

/** 다른 화면 서버가 그 잠금의 키로 /health 에 응답하는지. */
function healthOk(lock) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: lock.port,
        path: "/health",
        headers: { [KEY_HEADER]: lock.key },
        agent: false,
        timeout: HEALTH_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 && JSON.parse(body)?.ok === true);
          } catch {
            resolve(false);
          }
        });
        res.on("error", () => resolve(false));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * 허브 연결 하나를 유지하며 hub.sessions 를 묻는다. 허브가 없거나 프로토콜 < 11 이거나 실패하면
 * null — 연결을 버리고 다음 호출에 다시 연결한다(허브 재시작에서 저절로 회복). 허브를 띄우지 않는다.
 * @param {string} home
 * @returns {{fetch(): Promise<object|null>, close(): void}}
 */
export function makeHubSessionsFetcher(home) {
  let client = null;
  let closed = false;
  const drop = () => {
    try {
      client?.close();
    } catch {
      // 이미 끊긴 연결 — 버리기만 한다
    }
    client = null;
  };
  return {
    async fetch() {
      if (closed) return null;
      try {
        if (!client || client.closed || client.dead) {
          drop();
          const { connectIfLive } = await import("../connector/hub-client.js");
          const c = await connectIfLive({ home });
          if (!c) return null;
          if (closed) {
            c.close();
            return null;
          }
          client = c;
        }
        // stale 은 ping 의 프로토콜이 지금 버전보다 낮을 때만 채워진다
        if (client.stale && client.stale.protocol < SESSIONS_MIN_PROTOCOL) {
          drop();
          return null;
        }
        const r = await client.request("hub.sessions", {}, { timeoutMs: 3000 });
        if (r && typeof r === "object") return r;
        drop();
        return null;
      } catch {
        drop();
        return null;
      }
    },
    close() {
      closed = true;
      drop();
    },
  };
}

/**
 * @param {{home: string, version?: string, fetchSessions?: () => Promise<object|null>, pollMs?: number,
 *   sessionsPollMs?: number, idleMs?: number, now?: () => number, lock?: boolean,
 *   firstSessionsWaitMs?: number}} opts
 *   now 는 유휴 시간 계산에만 쓴다(테스트 주입). 주기는 실제 타이머.
 * @returns {Promise<{port: number, key: string, url: string, close(reason?: string): Promise<void>, closed: Promise<string>}>}
 */
export async function startViewServer({
  home,
  version = PACKAGE_VERSION,
  fetchSessions,
  pollMs = POLL_MS,
  sessionsPollMs = SESSIONS_POLL_MS,
  idleMs = IDLE_MS,
  now = Date.now,
  lock = true,
  firstSessionsWaitMs = FIRST_SESSIONS_WAIT_MS,
}) {
  const key = randomBytes(32).toString("hex");
  const startedAt = new Date().toISOString();
  const channelsDir = join(home, "channels");
  let fetcher = null;
  if (!fetchSessions) {
    fetcher = makeHubSessionsFetcher(home);
    fetchSessions = () => fetcher.fetch();
  }

  /** 파일 이름 → {mtimeMs, size, doc, view, active} (마지막으로 잘 읽힌 것) */
  const files = new Map();
  /** 마지막 hub.sessions 응답(없으면 null) */
  let sessions = null;
  /** 지금 알려진 세션 부분의 JSON(아래 sessionsPart 뒤에 "허브 꺼짐" 상태로 채운다) */
  let sessionsJson = "";
  let online = new Set();
  /** @type {Set<http.ServerResponse>} */
  const streams = new Set();
  let idleSince = now();
  let stopping = false;
  const timers = new Set();
  let pingTimer = null;
  let port = 0;

  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const broadcast = (event, data) => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) res.write(chunk);
  };

  const viewOf = (doc) => viewChannel(doc, { online, now: Date.now() });

  /** 채널 하나의 화면 모델과, 마지막으로 보낸 활동 중 값을 기록한다. */
  const remember = (entry, view) => {
    entry.view = view;
    entry.active = view.active;
  };

  /**
   * 채널 폴더를 훑는다. mtime·크기가 바뀐 파일만 다시 읽고, 바뀌었거나 active 가 뒤집힌 채널을
   * 스트림으로 보낸다. 깨진 JSON 은 기록하지 않아 다음 주기에 다시 읽는다(앞서 잘 읽힌 것은 남긴다).
   */
  const scan = () => {
    let names;
    try {
      names = readdirSync(channelsDir).filter((n) => CHANNEL_FILE.test(n));
    } catch {
      names = [];
    }
    const seen = new Set(names);
    for (const name of [...files.keys()])
      if (!seen.has(name)) files.delete(name);
    const t = Date.now();
    for (const name of names) {
      const file = join(channelsDir, name);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      const prev = files.get(name);
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
        // 내용은 그대로 — 시간이 지나 활동 중을 벗어났는지만 본다(판정은 model.js 한 곳)
        if (isActiveAt(prev.view, t) !== prev.active) {
          remember(prev, viewOf(prev.doc));
          broadcast("channel", prev.view);
        }
        continue;
      }
      let doc;
      try {
        doc = JSON.parse(readFileSync(file, "utf8"));
        if (!doc || typeof doc !== "object") throw new Error("not an object");
      } catch {
        continue;
      }
      const entry = { mtimeMs: st.mtimeMs, size: st.size, doc };
      remember(entry, viewOf(doc));
      files.set(name, entry);
      broadcast("channel", entry.view);
    }
  };

  const sessionsPart = () => {
    const { hub, sessions: list } = buildSnapshot({ channels: [], sessions });
    return { hub, sessions: list };
  };
  // 처음엔 "허브 꺼짐" — 첫 조회가 허브를 찾으면 바뀐 것으로 보고 sessions 이벤트를 보낸다
  sessionsJson = JSON.stringify(sessionsPart());

  /** hub.sessions 를 묻고, 바뀌었으면 sessions 이벤트와 참여자 접속 표시가 바뀐 채널을 보낸다. */
  const refreshSessions = async () => {
    let r = null;
    try {
      r = await fetchSessions();
    } catch {
      r = null;
    }
    if (stopping) return;
    let part;
    try {
      sessions = r && typeof r === "object" ? r : null;
      part = sessionsPart();
    } catch {
      // 모양이 이상한 응답은 허브 꺼짐으로 본다
      sessions = null;
      part = sessionsPart();
    }
    const json = JSON.stringify(part);
    if (json === sessionsJson) return;
    sessionsJson = json;
    try {
      online = new Set(part.sessions.map((s) => s.instanceId));
      broadcast("sessions", part);
      for (const entry of files.values()) {
        const before = JSON.stringify(entry.view.participants);
        const view = viewOf(entry.doc);
        if (JSON.stringify(view.participants) === before) continue;
        remember(entry, view);
        broadcast("channel", view);
      }
    } catch {
      // 한 번의 실패로 서버를 죽이지 않는다 — 다음 조회에서 다시 맞춘다
    }
  };

  /**
   * 잠금 확인. 제 잠금이면 그대로, 다른 port 의 살아 있는 서버가 쥐고 있으면 물러나고(false),
   * 없거나 응답 없는 서버를 가리키면 제 잠금을 쓴다.
   */
  const claimLock = async () => {
    const cur = readViewLock(home);
    if (cur && cur.pid === process.pid && cur.port === port && cur.key === key)
      return true;
    if (cur && cur.port !== port && (await healthOk(cur))) return false;
    if (stopping) return false;
    writeViewLock(home, { pid: process.pid, port, key, startedAt, version });
    return true;
  };

  const pollTick = async () => {
    if (stopping) return;
    try {
      scan();
      if (lock && !(await claimLock())) {
        if (!stopping) await close("yielded");
        return;
      }
      if (
        streams.size === 0 &&
        idleSince != null &&
        now() - idleSince > idleMs
      ) {
        await close("idle");
        return;
      }
    } catch {
      // 한 주기의 실패(예: 홈 폴더 권한)로 서버를 죽이지 않는다 — 다음 주기에 다시 한다
    }
    if (!stopping) later(pollTick, pollMs);
  };

  const sessionsTick = async () => {
    if (stopping) return;
    try {
      await refreshSessions();
    } catch {
      // 다음 주기에 다시 묻는다
    } finally {
      if (!stopping) later(sessionsTick, sessionsPollMs);
    }
  };

  const openStream = (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.on("error", () => {});
    if (req.method === "HEAD") return res.end();
    streams.add(res);
    idleSince = null;
    res.on("close", () => {
      if (!streams.delete(res)) return;
      if (streams.size === 0) idleSince = now();
    });
    // 첫 바이트를 바로 보내 브라우저 fetch 가 응답을 받게 한다
    res.write(`event: hello\ndata: ${JSON.stringify({ version })}\n\n`);
    // 지금 아는 세션 부분도 바로 보낸다. 첫 조회 전의 값은 자리 채움(허브 꺼짐)일 뿐이라 보내지 않는다 —
    // 첫 조회가 끝나면 바뀐 값이 sessions 이벤트로 간다.
    if (firstDone) res.write(`event: sessions\ndata: ${sessionsJson}\n\n`);
  };

  /** 첫 세션 조회가 끝났는지와, 그것을 기다리는 스냅샷 요청들(close 가 풀어 준다) */
  let firstDone = false;
  let firstSessions = null;
  const firstWaiters = new Set();
  const waitFirstSessions = () =>
    firstDone
      ? null
      : new Promise((resolve) => {
          const done = () => {
            clearTimeout(t);
            timers.delete(t);
            firstWaiters.delete(done);
            resolve();
          };
          const t = setTimeout(done, firstSessionsWaitMs);
          timers.add(t);
          firstWaiters.add(done);
          firstSessions.then(done);
        });

  const handle = async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // DNS 리바인딩 방지: 제 주소로 온 요청만 받는다
    const host = String(req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
      return send(res, 403, "forbidden");
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) {
      res.setHeader("Allow", "GET, HEAD");
      return send(res, 405, "method not allowed");
    }
    const path = String(req.url ?? "").split("?")[0];
    // 브라우저가 묻는 아이콘 — 없어도 콘솔 오류가 나지 않게 빈 응답
    if (path === "/favicon.ico") return send(res, 204, "", undefined, head);
    const asset = STATIC.get(path);
    if (asset) {
      let body;
      try {
        body = readFileSync(new URL(asset[0], STATIC_DIR));
      } catch {
        return send(res, 404, "not found");
      }
      return send(res, 200, body, asset[1], head);
    }
    if (!KEYED.has(path)) return send(res, 404, "not found");
    if (!keyMatches(req.headers[KEY_HEADER], key))
      return send(res, 403, "forbidden");
    const json = "application/json; charset=utf-8";
    if (path === "/health")
      return send(
        res,
        200,
        JSON.stringify({ ok: true, version, pid: process.pid }),
        json,
        head,
      );
    if (path === "/api/snapshot") {
      // 막 떠서 첫 세션 조회가 진행 중이면 잠깐(기본 최대 1.5초) 기다린다 — 허브 꺼짐으로 깜빡이지 않게
      await waitFirstSessions();
      if (stopping || res.destroyed) return;
      scan();
      const snap = buildSnapshot({
        channels: [...files.values()].map((e) => e.doc),
        sessions,
      });
      return send(res, 200, JSON.stringify(snap), json, head);
    }
    return openStream(req, res);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "internal error");
      else res.destroy();
    });
  });
  server.on("clientError", (_err, socket) => socket.destroy());

  let resolveClosed;
  const closed = new Promise((r) => (resolveClosed = r));
  let closing = null;
  /** @param {string} [reason] */
  function close(reason = "closed") {
    if (closing) return closing;
    stopping = true;
    closing = (async () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const done of [...firstWaiters]) done();
      if (pingTimer) clearInterval(pingTimer);
      for (const res of streams) res.end();
      streams.clear();
      fetcher?.close();
      if (lock && port) removeViewLockIf(home, { pid: process.pid, port });
      await new Promise((r) => {
        server.close(() => r());
        // 쉬고 있는 keep-alive 소켓과 끝내는 중인 스트림까지 바로 끊는다
        server.closeAllConnections?.();
      });
      resolveClosed(reason);
    })();
    return closing;
  }

  // 첫 세션 조회는 기다리지 않는다 — 허브가 멈춰 있어도 바로 열고 잠금을 쓴다. 끝나면 세션 주기가 이어 간다.
  firstSessions = refreshSessions()
    .catch(() => {})
    .then(() => {
      firstDone = true;
      if (!stopping) later(sessionsTick, sessionsPollMs);
    });
  scan();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = server.address().port;

  const handleObj = {
    port,
    key,
    url: `http://127.0.0.1:${port}/#key=${key}`,
    close,
    closed,
  };
  if (lock && !(await claimLock())) {
    await close("yielded");
    return handleObj;
  }
  pingTimer = setInterval(() => {
    for (const res of streams) res.write(": ping\n\n");
  }, STREAM_PING_MS);
  later(pollTick, pollMs);
  return handleObj;
}
