// 채널 문서 → 화면 모델(순수 함수). 허용 목록 필드만 내보내고 워커 로그는 가린다(view 설계 §4·§5).
// 공개 코드라 허브를 import 하지 않는다.

/** 화면에 내보내도 되는 태스크 필드(여기 없는 필드 — cwd·worker 로그 경로 등 — 는 절대 나가지 않는다). */
export const VIEW_TASK_FIELDS = [
  "taskId",
  "from",
  "to",
  "toTool",
  "toInstance",
  "kind",
  "mode",
  "status",
  "request",
  "result",
  "attachments",
  "review",
  "createdAt",
  "dispatchedAt",
  "updatedAt",
  "completedBy",
  "events",
];
export const LOG_TAIL_MARKER = "\n--- last log lines ---";
export const ACTIVE_WINDOW_MS = 600_000;
export const PREVIEW_CHARS = 120;
/** 이보다 오래 끝나지 않은 태스크는 '활동 중' 판정에서 뺀다(응답 없이 방치된 것). */
export const STALE_OPEN_MS = 86_400_000;

const OPEN_STATUSES = new Set(["submitted", "working"]);

/** 시각 문자열 → ms. 잘못된 값은 0. */
function ms(v) {
  const n = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** 워커 로그 꼬리를 결과에서 잘라 낸다. 문자열이 아니거나 마커가 없으면 그대로. */
export function redactResult(result) {
  if (typeof result !== "string") return result;
  const i = result.indexOf(LOG_TAIL_MARKER);
  if (i < 0) return result;
  return `${result.slice(0, i)}\n(worker log hidden)`;
}

/** @param {object} task @returns {object} */
export function viewTask(task) {
  const src = task && typeof task === "object" ? task : {};
  const out = {};
  for (const k of VIEW_TASK_FIELDS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  if ("result" in out) out.result = redactResult(out.result);
  if (Array.isArray(src.events)) {
    out.events = src.events
      .filter((e) => e && typeof e === "object")
      .map((e) => {
        const ev = { at: e.at, kind: e.kind, detail: e.detail };
        if (e.by !== undefined) ev.by = e.by;
        return ev;
      });
  }
  const flat = (typeof src.request === "string" ? src.request : "")
    .replace(/\s+/g, " ")
    .trim();
  out.preview =
    flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
  out.open = OPEN_STATUSES.has(src.status);
  return out;
}

function toolOf(id) {
  const s = String(id);
  const h = s.indexOf("#");
  return h >= 0 ? s.slice(0, h) : s.split(" ")[0];
}

/** 참여자: peers(instanceId, 옛 문서는 agent) + 태스크 from·to·completedBy. id 기준 중복 제거. */
function participantsOf(peers, tasks, online) {
  const map = new Map();
  const add = (id, tool, worker) => {
    if (typeof id !== "string" || !id) return;
    if (map.has(id)) return;
    map.set(id, {
      id,
      tool: tool ?? toolOf(id),
      worker,
      online: online.has(id),
    });
  };
  for (const p of peers) {
    if (!p || typeof p !== "object") continue;
    add(p.instanceId ?? p.agent, p.tool, p.worker === true);
  }
  for (const t of tasks) {
    add(t.from, undefined, false);
    add(t.to, undefined, false);
    const cb = t.completedBy;
    if (typeof cb === "string" && cb.endsWith(" worker"))
      add(cb, toolOf(cb), true);
    else add(cb, undefined, false);
  }
  return [...map.values()];
}

/**
 * 채널 화면 모델이 그 시각에 활동 중인지(viewChannel 의 activeUntil 하나로 정한다).
 * @param {{activeUntil?: number}} view @param {number} now @returns {boolean}
 */
export function isActiveAt(view, now) {
  const until = view?.activeUntil;
  return typeof until === "number" && now < until;
}

/**
 * @param {object} doc 채널 문서
 * @param {{online?: Set<string>, now?: number}} [opts]
 */
export function viewChannel(doc, opts = {}) {
  const online = opts.online ?? new Set();
  const now = opts.now ?? Date.now();
  const ch = (doc && doc.channel) || {};
  const rawTasks = Array.isArray(doc?.tasks)
    ? doc.tasks.filter((t) => t && typeof t === "object")
    : [];
  const rawContext = Array.isArray(doc?.context)
    ? doc.context.filter((c) => c && typeof c === "object")
    : [];
  const peers = Array.isArray(ch.peers) ? ch.peers : [];

  // 마지막 활동 = 태스크 updatedAt·메모 at 중 가장 늦은 것, 없으면 채널 생성 시각
  let latest = 0;
  for (const t of rawTasks) latest = Math.max(latest, ms(t.updatedAt));
  for (const c of rawContext) latest = Math.max(latest, ms(c.at));
  const last = latest || ms(ch.createdAt);

  const tasks = rawTasks
    .map(viewTask)
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  const openTaskCount = tasks.filter((t) => t.open).length;
  const freshOpenTaskCount = tasks.filter(
    (t) => t.open && now - ms(t.createdAt) < STALE_OPEN_MS,
  ).length;
  // 활동 중 판정은 이 한 값으로만 한다: 마지막 활동 + 10분, 열린 태스크는 만든 시각 + 하루 중
  // 늦은 것까지. 내용이 그대로면 시간이 지나 꺼지기만 하고 다시 켜지지 않는다(서버·화면 공용).
  let activeUntil = last + ACTIVE_WINDOW_MS;
  for (const t of tasks)
    if (t.open)
      activeUntil = Math.max(activeUntil, ms(t.createdAt) + STALE_OPEN_MS);
  const context = rawContext
    .map((c) => ({
      entryId: c.entryId,
      from: c.from,
      summary: c.summary,
      at: c.at,
    }))
    .sort((a, b) => ms(b.at) - ms(a.at));
  return {
    code: ch.code,
    createdAt: ch.createdAt,
    lastActivityAt: last
      ? new Date(last).toISOString()
      : (ch.createdAt ?? null),
    active: now < activeUntil,
    activeUntil,
    openTaskCount,
    freshOpenTaskCount,
    participants: participantsOf(peers, rawTasks, online),
    tasks,
    context,
  };
}

/**
 * @param {{channels: object[], sessions: object|null, now?: number}} input
 */
export function buildSnapshot({ channels, sessions, now = Date.now() }) {
  const list = Array.isArray(sessions?.sessions) ? sessions.sessions : [];
  const out = list
    .filter((s) => s && typeof s === "object")
    .map((s) => ({
      instanceId: s.instanceId,
      tool: s.tool,
      cwd: s.cwd,
      worker: s.worker,
      connectedAt: s.connectedAt,
    }));
  const online = new Set(out.map((s) => s.instanceId));
  const views = channels
    .map((d) => viewChannel(d, { online, now }))
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        ms(b.lastActivityAt) - ms(a.lastActivityAt),
    );
  return {
    generatedAt: new Date(now).toISOString(),
    hub: { running: sessions != null, sessionCount: out.length },
    sessions: out,
    channels: views,
  };
}
