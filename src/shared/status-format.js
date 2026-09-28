// Plan 6a(스펙 §6): `pluriply status` 의 판정·출력. 디스크 지문은 주입한 함수로만 읽는다(테스트 가능).
import { codeFingerprint } from "./fingerprint.js";

const APP = {
  antigravity: "Antigravity",
  "antigravity-ide": "Antigravity",
  "claude-desktop": "Claude Desktop",
};
const MARK = { restart: "✗", unknown: "?", ok: "✓" };
const ORDER = { restart: 0, unknown: 1, ok: 2 };

/** 공백·셸 특수문자가 있으면만 큰따옴표로 감싼다 @param {string} p @returns {string} */
function quotePath(p) {
  return /[\s"\\$`]/.test(p) ? `"${p.replace(/(["\\$`])/g, "\\$1")}"` : p;
}

/** @param {object} s 세션 @returns {string} 도구별 재시작 방법(영어) */
export function restartHint(s) {
  const id = s.threadId;
  const where = s.cwd ?? "its folder";
  const cd = s.cwd ? `cd ${quotePath(s.cwd)} && ` : "";
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
  return `quit and reopen ${APP[s.tool] ?? s.tool}`;
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
 * @param {{ping: {port: number, pid: number, version?: string, protocol?: number}, sessions: object|null, error: string|null, fingerprint?: typeof codeFingerprint}} o
 */
export function buildStatus({
  ping,
  sessions,
  error,
  fingerprint = codeFingerprint,
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
  if (!sessions)
    return {
      hub,
      sessions: null,
      workers: 0,
      sessionsError:
        error ??
        `hub protocol ${hub.protocol} < 10; run \`pluriply hub restart\` to see sessions`,
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
      return {
        ...s,
        onDisk: disk,
        state,
        restart: state === "restart" ? restartHint(s) : null,
      };
    })
    .sort(
      (a, b) =>
        ORDER[a.state] - ORDER[b.state] ||
        String(a.startedAt ?? a.connectedAt).localeCompare(
          String(b.startedAt ?? b.connectedAt),
        ),
    );
  return {
    hub,
    sessions: list,
    workers: all.length - list.length,
    sessionsError: null,
  };
}

/** @param {ReturnType<typeof buildStatus>} st @param {{home?: string, now?: Date}} [o] @returns {string[]} */
export function formatStatus(st, { home, now = new Date() } = {}) {
  const h = st.hub;
  const lines = [
    `hub      running (port ${h.port}, pid ${h.pid}, version ${h.version ?? "unknown"}, protocol ${h.protocol})`,
  ];
  const code = (v, fp) => `${v ?? "?"}${fp ? ` (${fp})` : ""}`;
  if (h.fingerprint) {
    const verdict =
      h.state === "ok"
        ? "✓ up to date"
        : h.state === "restart"
          ? "✗ restart: pluriply hub restart"
          : "? can't read the installed code";
    lines.push(
      `         code ${code(h.version, h.fingerprint)}  on disk ${h.onDisk ? code(h.onDisk.version, h.onDisk.fingerprint) : "?"}  ${verdict}`,
    );
  } else if (st.sessions !== null) {
    lines.push(
      `         code ${h.version ?? "?"} (fingerprint unavailable)  ? can't read the hub's code`,
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
    const sameVersion =
      s.version != null && s.onDisk?.version != null
        ? s.version === s.onDisk.version
        : false;
    const codeText =
      s.state === "ok"
        ? (s.version ?? "?")
        : !s.fingerprint
          ? s.version
            ? `${s.version} (fingerprint unavailable)`
            : "unknown (older connector)"
          : s.state === "restart"
            ? sameVersion
              ? `${code(s.version, s.fingerprint)} → ${code(s.onDisk.version, s.onDisk.fingerprint)} on disk`
              : `${s.version ?? "?"} → ${s.onDisk?.version ?? "?"} on disk`
            : `${s.version ?? "?"} (can't read the install)`;
    lines.push(
      `  ${MARK[s.state]} ${String(s.tool).padEnd(12)} ${shortPath(s.cwd, home).padEnd(24)} since ${formatWhen(s.startedAt ?? s.connectedAt, now).padEnd(11)} code ${codeText}`,
    );
    if (s.restart) lines.push(`      restart: ${s.restart}`);
  }
  return lines;
}
