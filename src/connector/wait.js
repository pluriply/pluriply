// wait_for_activity(Plan 5a 스펙 §4): 이 세션의 활동이 올 때까지 허브 agent.wait 를 짧게 반복한다.
// Claude Code 에서는 2분 뒤 백그라운드로 가서, 끝나면 알림으로 쉬는 세션을 깨운다(2026-09-27 스파이크).
export const CHUNK_MS = 15_000;
/** 잠깐 끊긴 연결 — 다음 요청이 재접속 배리어를 기다린다. hub unreachable(dead)은 여기에 없다. */
const TRANSIENT = /^hub (connection closed|connection error|request timed out)/;
const HANDLE =
  "Handle the items above (submit_result / submit_review for incoming tasks; read results with get_task_result)";

/** @param {string} agent @returns {{def: number, max: number}} 초 */
export function waitLimits(agent) {
  return agent === "claude-code"
    ? { def: 43_200, max: 86_400 }
    : { def: 50, max: 300 };
}

/** @param {string} agent @param {unknown} v @returns {number} 초. 1 미만·숫자 아님은 기본값, 상한 초과는 상한 */
export function clampWait(agent, v) {
  const { def, max } = waitLimits(agent);
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

/** @param {string} agent @param {"activity"|"idle"} status @returns {string} */
export function nextHint(agent, status) {
  if (agent === "claude-code")
    return status === "activity"
      ? `${HANDLE}, then call wait_for_activity again to keep listening.`
      : "Nothing arrived. Call wait_for_activity again to keep listening.";
  const tail =
    "Stop hooks will also report new activity at the end of each turn.";
  return status === "activity"
    ? `${HANDLE}. ${tail}`
    : `Nothing arrived. ${tail}`;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * promise 를 extra.signal 중단과 경합한다. 중단이 이기면 promise 는 그대로 살려 둔다 —
 * 호출한 쪽이 "다음 호출이 이어받는다" 규칙에 따라 계속 들고 있는다.
 * @param {Promise<any>} promise @param {AbortSignal|undefined} signal
 * @returns {Promise<{aborted: true}|{value: any}|{error: Error}>}
 */
function raceAbort(promise, signal) {
  const settled = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  if (!signal) return settled;
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    settled.then((result) => {
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    });
  });
}

/**
 * 커넥터 하나당 하나 만든다(세션당 대기 하나 — 진행 중이면 already_listening).
 * @param {{hubRequest: (type: string, payload?: object, opts?: object) => Promise<any>, agent: string, sleep?: (ms: number) => Promise<void>, now?: () => number}} deps
 * @returns {(args: {wait_seconds?: number}, code: string, extra?: object) => Promise<object>}
 */
export function makeWaitForActivity({
  hubRequest,
  agent,
  sleep = defaultSleep,
  now = Date.now,
}) {
  let listening = false;
  // 진행 중인 agent.wait 요청. 중단돼도 버리지 않고 남겨 둔다: 허브는 응답을 쓰는 순간
  // 이미 delivered 로 기록하므로(스펙 §13, 한 번만 전달), 이 요청이 마저 끝나면 다음 호출이
  // 그 결과를 첫 조각으로 이어받는다 — 그러지 않으면 항목이 조용히 사라진다.
  // 남는 한계: 이 orphan 요청이 끝나기 전에 커넥터 프로세스가 종료되면 그 항목은 그대로 유실된다
  // (스펙 §13의 한 번만 전달 한계와 동일).
  let inflight = null;
  return async ({ wait_seconds } = {}, _code, extra) => {
    if (listening) return { status: "already_listening" };
    listening = true;
    try {
      const deadline = now() + clampWait(agent, wait_seconds) * 1000;
      const signal = extra?.signal;
      const progressToken = extra?._meta?.progressToken;
      let ticks = 0;
      for (;;) {
        if (!inflight) {
          if (signal?.aborted) return { status: "cancelled" };
          const left = deadline - now();
          if (left <= 0)
            return { status: "idle", next: nextHint(agent, "idle") };
          const timeoutMs = Math.max(1, Math.min(CHUNK_MS, left));
          const p = hubRequest(
            "agent.wait",
            { timeoutMs },
            { timeoutMs: timeoutMs + 5000 },
          );
          p.catch(() => {}); // 중단돼 버려져도 처리되지 않은 거부로 남지 않게 한다
          inflight = p;
        }
        const settled = await raceAbort(inflight, signal);
        if (settled.aborted) return { status: "cancelled" }; // inflight 는 그대로 남긴다
        inflight = null; // 결과(또는 오류)를 소비하기 전에 비운다
        if (settled.error) {
          if (!TRANSIENT.test(settled.error.message)) throw settled.error;
          await sleep(1000);
          continue;
        }
        const r = settled.value;
        const incoming = r.incoming ?? [];
        const results = r.results ?? [];
        const stalled = r.stalled ?? [];
        if (incoming.length + results.length + stalled.length > 0)
          return {
            status: "activity",
            channelCode: r.channelCode,
            incoming,
            results,
            stalled,
            more: r.more ?? 0,
            next: nextHint(agent, "activity"),
          };
        if (progressToken !== undefined && extra?.sendNotification) {
          ticks++;
          await extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: ticks,
                message: "waiting for pluriply activity",
              },
            })
            .catch(() => {}); // 진행 알림은 최선 노력이라 실패해도 대기 자체는 계속한다
        }
      }
    } finally {
      listening = false;
    }
  };
}
