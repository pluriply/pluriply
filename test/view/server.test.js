import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  startViewServer,
  makeHubSessionsFetcher,
  KEY_HEADER,
  POLL_MS,
  SESSIONS_POLL_MS,
  IDLE_MS,
  FIRST_SESSIONS_WAIT_MS,
} from "../../src/view/server.js";
import { readViewLock, writeViewLock } from "../../src/shared/view-lock.js";
import { PACKAGE_VERSION } from "../../src/shared/version.js";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'";
const AT = "2026-11-01T00:00:00.000Z";

/**
 * 테스트마다 임시 홈 하나. 정리는 한 훅에서 순서대로 — 스트림 → 서버 → 홈
 * (node:test 는 t.after 를 등록 순서대로 돌리므로 훅을 나누면 홈이 서버보다 먼저 지워진다).
 */
function ctx(t) {
  const home = mkdtempSync(join(tmpdir(), "plp-view-"));
  const servers = [];
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.close();
    for (const s of servers) await s.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    async start(opts = {}) {
      const srv = await startViewServer({
        home,
        fetchSessions: async () => null,
        pollMs: 30,
        sessionsPollMs: 30,
        ...opts,
      });
      servers.push(srv);
      return srv;
    },
    async stream(srv) {
      const s = await openStream(srv);
      streams.push(s);
      return s;
    },
  };
}

function task(taskId, extra = {}) {
  return {
    taskId,
    from: "claude-code#aaaa",
    to: "codex",
    status: "completed",
    request: `do ${taskId}`,
    result: "ok",
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  };
}

function writeChannel(home, code, tasks = []) {
  const dir = join(home, "channels");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${code}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({
      channel: { code, createdAt: AT, peers: [] },
      tasks,
      context: [],
    }),
  );
  renameSync(tmp, file);
}

/** @returns {Promise<{status: number, headers: object, body: string}>} */
function request(srv, path, { method = "GET", headers = {}, key } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (key !== undefined) h[KEY_HEADER] = key;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: srv.port,
        path,
        method,
        headers: h,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function snapshot(srv) {
  const r = await request(srv, "/api/snapshot", { key: srv.key });
  assert.equal(r.status, 200);
  return { raw: r.body, doc: JSON.parse(r.body) };
}

/** 기한 안에 fn 이 참이 될 때까지 기다린다. */
async function until(fn, ms = 2000, what = "condition") {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** /api/events 를 열고 받은 이벤트를 모은다(SSE 본문을 손으로 나눈다). */
function openStream(srv) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: srv.port,
        path: "/api/events",
        headers: { [KEY_HEADER]: srv.key },
        agent: false,
      },
      (res) => {
        const s = {
          status: res.statusCode,
          headers: res.headers,
          raw: "",
          events: [],
          ended: false,
          close: () => req.destroy(),
          wait: (pred, ms = 2000, what = "event") =>
            until(() => s.events.find(pred), ms, what),
        };
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          s.raw += chunk;
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = "message";
            const data = [];
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) continue;
              if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("data: ")) data.push(line.slice(6));
            }
            if (data.length) s.events.push({ event, data: data.join("\n") });
          }
        });
        res.on("error", () => {});
        res.on("close", () => (s.ended = true));
        resolve(s);
      },
    );
    req.on("error", (err) => {
      if (err.code !== "ECONNRESET") reject(err);
    });
    req.end();
  });
}

test("view server constants", () => {
  assert.equal(POLL_MS, 1000);
  assert.equal(SESSIONS_POLL_MS, 5000);
  assert.equal(IDLE_MS, 1_800_000);
  assert.equal(KEY_HEADER, "x-pluriply-view-key");
  assert.equal(FIRST_SESSIONS_WAIT_MS, 1500);
});

test("rejects requests without the key", async (t) => {
  const c = ctx(t);
  const srv = await c.start();
  assert.match(srv.key, /^[0-9a-f]{64}$/);
  assert.equal(srv.url, `http://127.0.0.1:${srv.port}/#key=${srv.key}`);
  assert.equal((await request(srv, "/api/snapshot")).status, 403);
  assert.equal(
    (await request(srv, "/api/snapshot", { key: "0".repeat(64) })).status,
    403,
  );
  assert.equal((await request(srv, "/api/snapshot", { key: "x" })).status, 403);
  assert.equal((await request(srv, "/api/events")).status, 403);
  assert.equal((await request(srv, "/health")).status, 403);
  const ok = await request(srv, "/api/snapshot", { key: srv.key });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["set-cookie"], undefined);
  const health = await request(srv, "/health", { key: srv.key });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), {
    ok: true,
    version: PACKAGE_VERSION,
    pid: process.pid,
  });
});

test("rejects foreign host headers", async (t) => {
  const c = ctx(t);
  const srv = await c.start();
  const bad = await request(srv, "/", {
    headers: { host: `evil.example:${srv.port}` },
  });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers["content-security-policy"], CSP);
  assert.equal(
    (
      await request(srv, "/api/snapshot", {
        key: srv.key,
        headers: { host: `127.0.0.1:${srv.port + 1}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(srv, "/", { headers: { host: `localhost:${srv.port}` } }))
      .status,
    200,
  );
});

test("serves static files with security headers", async (t) => {
  const c = ctx(t);
  const srv = await c.start();
  const root = await request(srv, "/");
  assert.equal(root.status, 200);
  assert.equal(root.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(root.headers["content-security-policy"], CSP);
  assert.equal(root.headers["x-content-type-options"], "nosniff");
  assert.equal(root.headers["cache-control"], "no-store");
  assert.equal(root.headers["referrer-policy"], "no-referrer");
  assert.match(root.body, /<script type="module" src="\/app\.js"><\/script>/);
  const app = await request(srv, "/app.js");
  assert.equal(app.status, 200);
  assert.equal(app.headers["content-type"], "text/javascript; charset=utf-8");
  const md = await request(srv, "/markdown.js");
  assert.equal(md.status, 200);
  assert.equal(md.headers["content-type"], "text/javascript; charset=utf-8");
  assert.match(md.body, /export function parseMarkdown/);
  const rc = await request(srv, "/reconnect.js");
  assert.equal(rc.status, 200);
  assert.equal(rc.headers["content-type"], "text/javascript; charset=utf-8");
  assert.match(rc.body, /export function makeReconnect/);
  const css = await request(srv, "/app.css");
  assert.equal(css.status, 200);
  assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
  const post = await request(srv, "/api/snapshot", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers["content-security-policy"], CSP);
  const nope = await request(srv, "/nope");
  assert.equal(nope.status, 404);
  assert.equal(nope.headers["x-content-type-options"], "nosniff");
  assert.equal((await request(srv, "/static/app.js")).status, 404);
  assert.equal((await request(srv, "/../package.json")).status, 404);
  const icon = await request(srv, "/favicon.ico");
  assert.equal(icon.status, 204);
  assert.equal(icon.headers["content-security-policy"], CSP);
  const head = await request(srv, "/app.js", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

test("snapshot reads channels without the hub", async (t) => {
  const c = ctx(t);
  writeChannel(c.home, "plp-aaaa-aaaa", [task("task_a")]);
  writeChannel(c.home, "plp-bbbb-bbbb", [task("task_b")]);
  const srv = await c.start({ fetchSessions: async () => null });
  const { doc } = await snapshot(srv);
  assert.equal(doc.hub.running, false);
  assert.deepEqual(doc.sessions, []);
  assert.deepEqual(doc.channels.map((ch) => ch.code).sort(), [
    "plp-aaaa-aaaa",
    "plp-bbbb-bbbb",
  ]);
});

test("snapshot skips a corrupt channel file", async (t) => {
  const c = ctx(t);
  writeChannel(c.home, "plp-aaaa-aaaa", [task("task_a")]);
  writeFileSync(join(c.home, "channels", "plp-zzzz-zzzz.json"), "{");
  // 채널 이름 꼴이 아닌 파일·쓰는 중인 tmp 는 읽지 않는다
  writeFileSync(join(c.home, "channels", "notes.json"), "{}");
  writeFileSync(join(c.home, "channels", "plp-cccc-cccc.json.1.tmp"), "{}");
  const srv = await c.start();
  const { doc } = await snapshot(srv);
  assert.deepEqual(
    doc.channels.map((ch) => ch.code),
    ["plp-aaaa-aaaa"],
  );
  // 다음 주기에 다시 읽는다 — 고쳐지면 나타난다
  writeChannel(c.home, "plp-zzzz-zzzz", [task("task_z")]);
  const again = await snapshot(srv);
  assert.deepEqual(again.doc.channels.map((ch) => ch.code).sort(), [
    "plp-aaaa-aaaa",
    "plp-zzzz-zzzz",
  ]);
});

test("never reads worker files", async (t) => {
  const c = ctx(t);
  mkdirSync(join(c.home, "workers"), { recursive: true });
  writeFileSync(join(c.home, "workers", "task_x.log"), "SECRET-123\n");
  mkdirSync(join(c.home, "logs"), { recursive: true });
  writeFileSync(join(c.home, "logs", "hub.log"), "SECRET-123\n");
  writeFileSync(join(c.home, "agents.json"), '{"x":"SECRET-123"}');
  writeFileSync(join(c.home, "config.json"), '{"x":"SECRET-123"}');
  const failed = task("task_x", {
    status: "failed",
    result: "exit\n--- last log lines ---\nSECRET-456",
    worker: { log: join(c.home, "workers", "task_x.log") },
  });
  writeChannel(c.home, "plp-aaaa-aaaa", [failed]);
  const srv = await c.start({ pollMs: 50 });
  const { raw } = await snapshot(srv);
  assert.doesNotMatch(raw, /SECRET-123|SECRET-456/);
  assert.match(raw, /worker log hidden/);
  const s = await c.stream(srv);
  await s.wait((e) => e.event === "hello");
  // 채널을 바꿔 그 채널 이벤트도 받아 본다
  writeChannel(c.home, "plp-aaaa-aaaa", [failed, task("task_y")]);
  await s.wait((e) => e.event === "channel" && e.data.includes("task_y"));
  assert.doesNotMatch(s.raw, /SECRET-123|SECRET-456/);
  assert.match(s.raw, /worker log hidden/);
});

test("streams channel changes", async (t) => {
  const c = ctx(t);
  writeChannel(c.home, "plp-aaaa-aaaa", [task("task_a")]);
  const srv = await c.start({ pollMs: 50 });
  const s = await c.stream(srv);
  assert.equal(s.status, 200);
  assert.equal(s.headers["content-type"], "text/event-stream");
  assert.equal(s.headers["content-security-policy"], CSP);
  const hello = await s.wait((e) => e.event === "hello");
  assert.deepEqual(JSON.parse(hello.data), { version: PACKAGE_VERSION });
  writeChannel(c.home, "plp-aaaa-aaaa", [task("task_a"), task("task_new")]);
  const ev = await s.wait(
    (e) => e.event === "channel" && e.data.includes("task_new"),
    2000,
    "channel event",
  );
  const view = JSON.parse(ev.data);
  assert.equal(view.code, "plp-aaaa-aaaa");
  assert.ok(view.tasks.some((x) => x.taskId === "task_new"));
  // 새 채널도 channel 이벤트로 온다
  writeChannel(c.home, "plp-bbbb-bbbb", [task("task_b")]);
  await s.wait(
    (e) => e.event === "channel" && JSON.parse(e.data).code === "plp-bbbb-bbbb",
    2000,
    "new channel event",
  );
});

test("sessions recover after fetch failures", async (t) => {
  const c = ctx(t);
  let mode = "null";
  const sessions = {
    sessions: [
      {
        instanceId: "claude-code#aaaa",
        tool: "claude-code",
        cwd: "/w",
        worker: false,
        connectedAt: AT,
      },
    ],
  };
  const srv = await c.start({
    sessionsPollMs: 50,
    fetchSessions: async () => {
      if (mode === "throw") throw new Error("hub gone");
      return mode === "up" ? sessions : null;
    },
  });
  assert.equal((await snapshot(srv)).doc.hub.running, false);
  const s = await c.stream(srv);
  await s.wait((e) => e.event === "hello");
  const running = () =>
    s.events
      .filter((e) => e.event === "sessions")
      .map((e) => JSON.parse(e.data).hub.running);
  mode = "up";
  await until(() => running().at(-1) === true, 2000, "hub up");
  const up = s.events.filter((e) => e.event === "sessions").at(-1);
  assert.deepEqual(JSON.parse(up.data), {
    hub: { running: true, sessionCount: 1 },
    sessions: sessions.sessions,
  });
  mode = "throw";
  await until(() => running().at(-1) === false, 2000, "hub down");
  mode = "up";
  await until(() => running().at(-1) === true, 2000, "hub up again");
  mode = "null";
  await until(() => running().at(-1) === false, 2000, "hub down again");
  // 맨 앞은 스트림을 열 때 hello 다음에 받은 지금 값(허브 꺼짐)
  assert.deepEqual(running(), [false, true, false, true, false]);
  assert.equal((await snapshot(srv)).doc.hub.running, false);
});

test("does not wait for a stuck hub", async (t) => {
  const c = ctx(t);
  const srv = await c.start({
    fetchSessions: () => new Promise(() => {}),
    firstSessionsWaitMs: 50,
  });
  // 멈춘 허브를 기다리지 않고 잠금을 쓰고 건강 확인에 답한다
  assert.equal(readViewLock(c.home).port, srv.port);
  assert.equal((await request(srv, "/health", { key: srv.key })).status, 200);
  // 스냅샷은 주입한 상한(50ms)만 기다린다 — 기본 1.5초보다 넉넉히 짧은 한 번의 상한만 본다
  const s0 = Date.now();
  const { doc } = await snapshot(srv);
  assert.ok(Date.now() - s0 < 1000, `snapshot took ${Date.now() - s0} ms`);
  assert.equal(doc.hub.running, false);
});

test("snapshot waits briefly for the first sessions fetch", async (t) => {
  const c = ctx(t);
  const sessions = {
    sessions: [{ instanceId: "codex#bbbb", tool: "codex", connectedAt: AT }],
  };
  let release;
  const gate = new Promise((r) => (release = r));
  let calls = 0;
  const srv = await c.start({
    sessionsPollMs: 5000,
    fetchSessions: async () => {
      calls += 1;
      if (calls === 1) await gate;
      return sessions;
    },
  });
  // 스트림은 첫 조회가 끝나면 sessions 이벤트로 허브 상태를 받는다
  const s = await c.stream(srv);
  await s.wait((e) => e.event === "hello");
  const pending = snapshot(srv);
  setTimeout(release, 100);
  const { doc } = await pending;
  assert.equal(doc.hub.running, true);
  assert.equal(doc.hub.sessionCount, 1);
  const ev = await s.wait((e) => e.event === "sessions");
  assert.equal(JSON.parse(ev.data).hub.running, true);
});

test("large channel streams intact", async (t) => {
  const c = ctx(t);
  writeChannel(c.home, "plp-aaaa-aaaa", [task("task_a")]);
  const srv = await c.start({ pollMs: 50 });
  const s = await c.stream(srv);
  await s.wait((e) => e.event === "hello");
  const big = "x".repeat(199_992) + "\n```\nend";
  assert.equal(big.length, 200_000);
  writeChannel(c.home, "plp-aaaa-aaaa", [
    task("task_a"),
    task("task_big", { result: big }),
  ]);
  const ev = await s.wait(
    (e) => e.event === "channel" && e.data.includes("task_big"),
    3000,
    "large channel event",
  );
  const view = JSON.parse(ev.data);
  assert.equal(
    view.tasks.find((x) => x.taskId === "task_big").result.length,
    200_000,
  );
});

test("exits when idle", async (t) => {
  const c = ctx(t);
  let clock = 1_000_000;
  const srv = await c.start({
    idleMs: 1000,
    pollMs: 20,
    now: () => clock,
  });
  assert.equal(readViewLock(c.home).port, srv.port);
  const s = await c.stream(srv);
  await s.wait((e) => e.event === "hello");
  clock += 5000;
  const early = await Promise.race([srv.closed, sleep(150, "open")]);
  assert.equal(early, "open");
  s.close();
  // 서버가 스트림이 닫힌 것을 본 뒤부터 유휴 시간을 센다 — 닫힐 때까지 시계를 밀어 준다
  let reason;
  srv.closed.then((r) => (reason = r));
  await until(
    () => {
      clock += 600;
      return reason;
    },
    2000,
    "idle close",
  );
  assert.equal(reason, "idle");
  assert.equal(existsSync(join(c.home, "view.json")), false);
});

test("second server yields to the lock owner", async (t) => {
  const c = ctx(t);
  const a = await c.start();
  const lockA = readViewLock(c.home);
  assert.equal(lockA.port, a.port);
  assert.equal(lockA.pid, process.pid);
  assert.equal(lockA.key, a.key);
  assert.equal(lockA.version, PACKAGE_VERSION);
  assert.ok(!Number.isNaN(Date.parse(lockA.startedAt)));
  const b = await c.start();
  assert.equal(await b.closed, "yielded");
  assert.equal(readViewLock(c.home).port, a.port);
  // A 는 계속 응답한다
  assert.equal((await request(a, "/health", { key: a.key })).status, 200);
});

test("yields when another live server takes the lock", async (t) => {
  const c = ctx(t);
  const a = await c.start({ pollMs: 20 });
  const other = await c.start({ lock: false });
  assert.equal(readViewLock(c.home).port, a.port);
  writeViewLock(c.home, {
    pid: process.pid,
    port: other.port,
    key: other.key,
    startedAt: new Date().toISOString(),
    version: PACKAGE_VERSION,
  });
  assert.equal(await a.closed, "yielded");
  assert.equal(readViewLock(c.home).port, other.port);
});

test("rewrites a missing or stale lock", async (t) => {
  const c = ctx(t);
  const a = await c.start({ pollMs: 20 });
  rmSync(join(c.home, "view.json"));
  await until(() => readViewLock(c.home)?.port === a.port, 2000, "lock back");
  // 응답 없는 서버를 가리키는 잠금은 되찾는다
  writeViewLock(c.home, {
    pid: process.pid,
    port: 1,
    key: "0".repeat(64),
    startedAt: new Date().toISOString(),
    version: PACKAGE_VERSION,
  });
  await until(
    () => readViewLock(c.home)?.port === a.port,
    3000,
    "lock retaken",
  );
  await a.close();
  assert.equal(existsSync(join(c.home, "view.json")), false);
});

test("close is idempotent and ends open streams", async (t) => {
  const c = ctx(t);
  const srv = await c.start();
  const s = await c.stream(srv);
  await s.wait((e) => e.event === "hello");
  await Promise.all([srv.close("stopped"), srv.close()]);
  assert.equal(await srv.closed, "stopped");
  await until(() => s.ended, 2000, "stream end");
});

test("a stale open channel is not re-sent without a file change", async (t) => {
  const c = ctx(t);
  // 50일 전에 보낸 채 답이 없는 태스크 하나 — 활동 중이 아니고, 시간이 지나도 계속 아니다
  const old = new Date(Date.now() - 50 * 86_400_000).toISOString();
  writeChannel(c.home, "plp-aaaa-aaaa", [
    task("task_old", { status: "submitted", createdAt: old, updatedAt: old }),
  ]);
  const srv = await c.start({ pollMs: 50 });
  const { doc } = await snapshot(srv);
  assert.equal(doc.channels[0].active, false);
  const s = await c.stream(srv);
  await s.wait((e) => e.event === "hello");
  await sleep(1000);
  assert.deepEqual(
    s.events.filter((e) => e.event === "channel"),
    [],
  );
});

test("bad session entries do not stop the server", async (t) => {
  const c = ctx(t);
  writeChannel(c.home, "plp-aaaa-aaaa", [task("task_a")]);
  const valid = {
    instanceId: "codex#k2ck",
    tool: "codex",
    cwd: "/w",
    worker: false,
    connectedAt: AT,
  };
  let calls = 0;
  const srv = await c.start({
    sessionsPollMs: 30,
    fetchSessions: async () => {
      calls += 1;
      return { sessions: [null, valid] };
    },
  });
  const { doc } = await snapshot(srv);
  assert.deepEqual(doc.sessions, [valid]);
  // 세션 주기가 계속 돈다(첫 조회 뒤에도 다음 조회가 잡힌다)
  await until(() => calls >= 3, 2000, "more sessions polls");
  assert.equal((await request(srv, "/health", { key: srv.key })).status, 200);
});

test("a throwing sessions step still lets snapshots answer and polls continue", async (t) => {
  const c = ctx(t);
  let calls = 0;
  // 응답 객체를 읽는 순간 던진다 — 세션 부분을 만드는 단계의 실패
  const boom = {};
  Object.defineProperty(boom, "sessions", {
    get() {
      throw new Error("boom");
    },
  });
  const srv = await c.start({
    sessionsPollMs: 30,
    fetchSessions: async () => {
      calls += 1;
      return boom;
    },
  });
  // 모양이 이상한 응답은 허브 꺼짐으로 본다
  assert.equal((await snapshot(srv)).doc.hub.running, false);
  await until(() => calls >= 3, 2000, "more sessions polls");
  assert.equal((await request(srv, "/health", { key: srv.key })).status, 200);
});

test("a new stream gets the current sessions right after hello", async (t) => {
  const c = ctx(t);
  const sessions = {
    sessions: [{ instanceId: "codex#bbbb", tool: "codex", connectedAt: AT }],
  };
  const srv = await c.start({
    sessionsPollMs: 5000,
    fetchSessions: async () => sessions,
  });
  // 스냅샷이 첫 조회를 기다려 주므로 이 뒤엔 세션이 알려져 있다
  assert.equal((await snapshot(srv)).doc.hub.running, true);
  const s = await c.stream(srv);
  await until(() => s.events.length >= 2, 2000, "hello and sessions");
  assert.equal(s.events[0].event, "hello");
  assert.equal(s.events[1].event, "sessions");
  assert.deepEqual(JSON.parse(s.events[1].data).hub, {
    running: true,
    sessionCount: 1,
  });
});

test("hub sessions fetcher returns null without a hub", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "plp-view-"));
  const f = makeHubSessionsFetcher(home);
  t.after(() => {
    f.close();
    rmSync(home, { recursive: true, force: true });
  });
  assert.equal(await f.fetch(), null);
  assert.equal(await f.fetch(), null);
});
