// Plan 6a(스펙 §6): `pluriply status` 의 판정·출력. 디스크 지문은 주입한 함수로만 읽는다(테스트 가능).
// Plan 6c(스펙 §5): 세션의 깨우기 상태(wake on/off/failed)와 최근 24시간의 문제(problems)를 보여 준다 —
// 문제가 없으면 출력은 6a 와 같다.
import { codeFingerprint } from "./fingerprint.js";

const APP = {
  antigravity: "Antigravity",
  "antigravity-ide": "Antigravity",
  "claude-desktop": "Claude Desktop",
};
const MARK = { restart: "✗", unknown: "?", ok: "✓" };
const ORDER = { restart: 0, unknown: 1, ok: 2 };
/** problems 의 요청 앞 글자 수와 사건 설명 글자 수 */
const REQUEST_CHARS = 40;
const DETAIL_CHARS = 70;
/** 깨우기 이유·허브 사건 설명의 글자 수(한 줄 유지) */
const REASON_CHARS = 120;

/** 공백·셸 특수문자가 있으면만 큰따옴표로 감싼다 @param {string} p @returns {string} */
function quotePath(p) {
  return /[\s"\\$`]/.test(p) ? `"${p.replace(/(["\\$`])/g, "\\$1")}"` : p;
}

/**
 * 커넥터·허브가 넘긴 글을 터미널에 안전한 한 줄로 만든다(자르지 않는다 — 복사해 쓰는 경로·버전용).
 * ANSI 이스케이프를 먼저 지우고, 남은 제어 문자는 공백으로 바꾸고, 공백을 압축한다.
 * @param {unknown} text @returns {string}
 */
function clean(text) {
  return String(text ?? "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** clean 한 뒤 n 자에서 자른다("…") @param {unknown} text @param {number} [n] @returns {string} */
function cut(text, n = Infinity) {
  const one = clean(text);
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/** @param {object} s 세션 @returns {string} 도구별 재시작 방법(영어) */
export function restartHint(s) {
  const id = s.threadId == null ? s.threadId : clean(s.threadId);
  const cwd = s.cwd ? clean(s.cwd) : null;
  const tool = clean(String(s.tool)); // 빠진 값은 예전처럼 "undefined" 로 보인다
  const where = cwd || "its folder";
  const cd = cwd ? `cd ${quotePath(cwd)} && ` : "";
  s = { ...s, tool };
  if (s.tool === "claude-code")
    return id
      ? `/exit, then  ${cd}claude --resume ${id}`
      : `/exit and start claude again in ${where}`;
  if (s.tool === "codex") {
    if (s.wake)
      return id
        ? `exit, then  ${cd}pluriply codex resume ${id}`
        : `exit and run pluriply codex in ${where}`;
    return id
      ? `exit, then  ${cd}codex resume ${id}`
      : `exit and start codex again in ${where}`;
  }
  return `quit and reopen ${APP[tool] ?? tool}`;
}

/** 홈은 `~`, 길면 가운데를 `…` 로 @param {string|null} p @param {string} [home] @returns {string} */
export function shortPath(p, home) {
  if (!p) return "?";
  let s =
    home && (p === home || p.startsWith(`${home}/`))
      ? `~${p.slice(home.length)}`
      : p;
  const parts = s.split("/");
  if (s.length >= 32 && parts.length > 3)
    s = `${parts[0]}/${parts[1]}/…/${parts[parts.length - 1]}`;
  return s;
}

/** 오늘이면 HH:MM, 아니면 MM-DD HH:MM(로컬) @param {string|null} iso @param {Date} now @returns {string} */
export function formatWhen(iso, now = new Date()) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "?";
  const two = (n) => String(n).padStart(2, "0");
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.toDateString() === now.toDateString()
    ? hm
    : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
}

/**
 * 문제 태스크 한 줄의 사건 요약(Plan 6c §5.1): 사건 종류를 순서대로 잇고, 마지막이 워커 이관이 아니면
 * 그 사유를 붙인다. 예: `wake-failed, then to-worker`, `unclaimed — no live session picked it up within 180s`.
 * @param {Array<{kind: string, detail?: string}>} events @returns {string}
 */
export function summarizeEvents(events) {
  const list = Array.isArray(events)
    ? events.filter((e) => e && typeof e === "object")
    : [];
  if (list.length === 0) return "";
  const chain = list.map((e) => e.kind).join(", then ");
  const last = list[list.length - 1];
  return last.kind === "to-worker" || !last.detail
    ? chain
    : `${chain} — ${cut(last.detail, DETAIL_CHARS)}`;
}

/**
 * @param {{ping: {port: number, pid: number, version?: string, protocol?: number}, sessions: object|null, error: string|null, fingerprint?: typeof codeFingerprint, logFile?: string|null}} o
 *   logFile 은 자동 기동 허브의 로그 파일(CLI 가 홈으로 만든다). problems 는 hub.sessions 응답의 것(옛 허브면 비어 있다).
 */
export function buildStatus({
  ping,
  sessions,
  error,
  fingerprint = codeFingerprint,
  logFile = null,
}) {
  const cache = new Map();
  const onDisk = (root, part) => {
    if (!root) return null;
    const k = `${root}|${part}`;
    if (!cache.has(k)) {
      let v = null;
      try {
        v = fingerprint(root, part);
      } catch {
        v = null;
      }
      cache.set(k, v);
    }
    return cache.get(k);
  };
  const h = sessions?.hub ?? null;
  const hubDisk = h ? onDisk(h.root, "hub") : null;
  const hub = {
    running: true,
    port: ping.port,
    pid: h?.pid ?? ping.pid,
    protocol: h?.protocol ?? ping.protocol ?? 1,
    version: h?.version ?? ping.version ?? null,
    fingerprint: h?.fingerprint ?? null,
    root: h?.root ?? null,
    startedAt: h?.startedAt ?? null,
    onDisk: hubDisk,
    state:
      h?.fingerprint && hubDisk
        ? hubDisk.fingerprint === h.fingerprint
          ? "ok"
          : "restart"
        : "unknown",
  };
  const problems = {
    tasks: Array.isArray(sessions?.problems?.tasks)
      ? sessions.problems.tasks
      : [],
    events: Array.isArray(sessions?.problems?.events)
      ? sessions.problems.events
      : [],
  };
  if (!sessions)
    return {
      hub,
      sessions: null,
      workers: 0,
      sessionsError:
        error ??
        `hub protocol ${hub.protocol} < 11; run \`pluriply hub restart\` to see sessions`,
      problems,
      logFile,
    };
  const all = sessions.sessions ?? [];
  const list = all
    .filter((s) => !s.worker)
    .map((s) => {
      const disk = s.fingerprint ? onDisk(s.root, "connector") : null;
      const state = !s.fingerprint
        ? s.version
          ? "unknown" // 지문 계산에는 실패했지만 버전은 아는 새 커넥터
          : "restart" // 버전·지문 둘 다 없는 옛 커넥터
        : !disk
          ? "unknown"
          : disk.fingerprint === s.fingerprint
            ? "ok"
            : "restart";
      const wakeState = s.wakeState ?? null;
      return {
        ...s,
        wakeState,
        wakeReason: s.wakeReason ?? null,
        wakeAt: s.wakeAt ?? null,
        onDisk: disk,
        state,
        restart: state === "restart" ? restartHint(s) : null,
        // Plan 6c: 깨우기가 멈춘 세션은 `pluriply codex` 로 다시 여는 것이 고치는 방법이다(D6). 옛 코드
        // 표시가 우선한다 — 그 재시작 안내가 이미 같은 말을 한다.
        fix:
          state !== "restart" && wakeState === "failed"
            ? restartHint({ ...s, wake: true })
            : null,
      };
    })
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        String(a.startedAt ?? a.connectedAt).localeCompare(
          String(b.startedAt ?? b.connectedAt),
        ),
    );
  return {
    hub,
    sessions: list,
    workers: all.length - list.length,
    sessionsError: null,
    problems,
    logFile,
  };
}

/** 정렬 순위: 재시작 필요 → 모름 → (같은 상태 안에서) 깨우기 실패 먼저 */
function rank(s) {
  return ORDER[s.state] * 2 + (s.wakeState === "failed" ? 0 : 1);
}

/** 세션 줄의 표시: 옛 코드 표시가 우선, 그다음 깨우기 실패 `!`, 깨우기 꺼짐 `·` @param {object} s */
function markOf(s) {
  if (s.state !== "ok") return MARK[s.state];
  if (s.wakeState === "failed") return "!";
  if (s.wakeState === "off") return "·";
  return MARK.ok;
}

/** 세션 줄 끝의 깨우기 상태(보고가 있을 때만) @param {object} s @param {Date} now @returns {string} */
function wakeText(s, now) {
  if (s.wakeState === "on") return "   wake on";
  if (s.wakeState === "failed")
    return `   wake failed ${formatWhen(s.wakeAt, now)}: ${cut(s.wakeReason ?? "no reason given", REASON_CHARS)}`;
  if (s.wakeState === "off")
    return `   wake off (${cut(s.wakeReason ?? "no reason given", REASON_CHARS)})`;
  return "";
}

/** @param {ReturnType<typeof buildStatus>} st @param {{home?: string, now?: Date}} [o] @returns {string[]} */
export function formatStatus(st, { home, now = new Date() } = {}) {
  const h = st.hub;
  const lines = [
    `hub      running (port ${h.port}, pid ${h.pid}, version ${clean(h.version ?? "unknown")}, protocol ${h.protocol})`,
  ];
  const code = (v, fp) => `${clean(v ?? "?")}${fp ? ` (${clean(fp)})` : ""}`;
  if (h.fingerprint) {
    const verdict =
      h.state === "ok"
        ? "✓ up to date"
        : h.state === "restart"
          ? "✗ restart: pluriply hub restart"
          : "? can't read the installed code";
    // 지문이 같고 버전 번호만 다르면 "같은 코드"다(버전은 지문에 들어가지 않는다)
    const same =
      h.state === "ok" &&
      h.version != null &&
      h.onDisk?.version != null &&
      h.version !== h.onDisk.version;
    lines.push(
      same
        ? `         code ${clean(h.version ?? "?")} (same code as ${clean(h.onDisk.version)} on disk)  ${verdict}`
        : `         code ${code(h.version, h.fingerprint)}  on disk ${h.onDisk ? code(h.onDisk.version, h.onDisk.fingerprint) : "?"}  ${verdict}`,
    );
  } else if (st.sessions !== null) {
    lines.push(
      `         code ${clean(h.version ?? "?")} (fingerprint unavailable)  ? can't read the hub's code`,
    );
  }
  if (!st.sessions) {
    lines.push(`sessions unavailable (${st.sessionsError})`);
    return lines;
  }
  const need = st.sessions.filter((s) => s.state === "restart").length;
  lines.push(
    `sessions ${st.sessions.length} connected, ${need} need a restart   (workers: ${st.workers} running)`,
  );
  for (const s of st.sessions) {
    const ver = clean(s.version ?? "?");
    const diskVer = s.onDisk?.version != null ? clean(s.onDisk.version) : null;
    const sameVersion =
      s.version != null && s.onDisk?.version != null
        ? s.version === s.onDisk.version
        : false;
    const codeText =
      s.state === "ok"
        ? s.version != null && diskVer != null && ver !== diskVer
          ? `${ver} (same code as ${diskVer} on disk)`
          : ver
        : !s.fingerprint
          ? s.version
            ? `${ver} (fingerprint unavailable)`
            : "unknown (older connector)"
          : s.state === "restart"
            ? sameVersion
              ? `${code(s.version, s.fingerprint)} → ${code(s.onDisk.version, s.onDisk.fingerprint)} on disk`
              : `${ver} → ${diskVer ?? "?"} on disk`
            : `${ver} (can't read the install)`;
    lines.push(
      `  ${markOf(s)} ${clean(String(s.tool)).padEnd(12)} ${shortPath(cut(s.cwd) || null, home).padEnd(24)} since ${formatWhen(s.startedAt ?? s.connectedAt, now).padEnd(11)} code ${codeText}${wakeText(s, now)}`,
    );
    if (s.restart) lines.push(`      restart: ${s.restart}`);
    else if (s.fix) lines.push(`      fix: ${s.fix}`);
  }
  // Plan 6c §5.1: 최근 24시간의 문제 — 있을 때만 절이 생긴다
  const { tasks, events } = st.problems ?? { tasks: [], events: [] };
  if (tasks.length + events.length > 0) {
    lines.push("", "problems (last 24h)");
    for (const p of tasks)
      lines.push(
        `  ${formatWhen(p.at, now)}  task ${cut(p.taskId)}  → ${cut(p.to)}   ${summarizeEvents(p.events)}   "${cut(p.request, REQUEST_CHARS)}"`,
      );
    for (const e of events)
      lines.push(
        e.kind === "hook-unpaired"
          ? `  ${formatWhen(e.at, now)}  hook         ${cut(e.tool ?? "?")} ${shortPath(cut(e.cwd) || null, home)}   ${cut(e.detail, REASON_CHARS)}`
          : `  ${formatWhen(e.at, now)}  hub          ${cut(e.detail, REASON_CHARS)}`,
      );
    if (st.logFile) lines.push(`  logs: ${shortPath(st.logFile, home)}`);
  }
  return lines;
}
