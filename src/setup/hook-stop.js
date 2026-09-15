// Stop 훅 명령의 본체(스펙 §3·§5). 도구가 턴을 끝낼 때 불려 허브에 "나에게 온 것"을 묻고,
// 있으면 {"decision":"block","reason":…} 으로 세션이 이어서 일하게 한다. 어떤 경우에도 {} 로
// 조용히 끝나야 한다 — 훅이 도구를 방해하면 안 된다.
// 공개 미러에도 실리므로 허브·커넥터는 쓰는 순간에만 동적으로 불러온다(경계 테스트).
import { pluriplyHome } from "../shared/paths.js";
import { resolveAgentName } from "../shared/identity.js";

export const HOOK_AGENTS = ["claude-code", "codex", "antigravity"];
const MAX_REASON = 2000;
const MORE_LINE = (n) => `(+${n} more: run list_tasks)`;

/**
 * 허브 hook.poll 응답을 모델이 읽을 문구로 만든다. 순수 함수.
 * @param {{tool: string, cwd: string, channelCode: string, incoming: object[], results: object[], more: number}} r
 * @returns {string}
 */
export function formatStopReason(r) {
  const head = `pluriply: new activity on channel ${r.channelCode} for ${r.tool} (cwd ${r.cwd}). Handle it before finishing.`;
  const inLines = (r.incoming ?? []).map(
    (t) => `- ${t.taskId} ${t.kind ?? "task"} from ${t.from}: "${t.summary}"`,
  );
  const resLines = (r.results ?? []).map(
    (t) => `- ${t.taskId} ${t.status} by ${t.to}: "${t.summary}"`,
  );
  let more = r.more ?? 0;
  const build = () => {
    const parts = [head];
    if (inLines.length)
      parts.push(
        "Incoming tasks (do the work, then submit_result — or submit_review for reviews; skip one another instance already claimed):",
        ...inLines,
      );
    if (resLines.length)
      parts.push(
        "Results of tasks you delegated (read them with get_task_result):",
        ...resLines,
      );
    if (more > 0) parts.push(MORE_LINE(more));
    return parts.join("\n");
  };
  let text = build();
  // 2,000자를 넘으면 뒤 항목부터 덜어내고 more 를 늘린다
  while (text.length > MAX_REASON && inLines.length + resLines.length > 0) {
    if (resLines.length) resLines.pop();
    else inLines.pop();
    more++;
    text = build();
  }
  return text;
}

/** @param {string} input @returns {object} 손상·빈 입력은 {} */
function parseInput(input) {
  try {
    const v = JSON.parse(input);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * @param {{agent: string, input?: string, cwd?: string, home?: string, env?: NodeJS.ProcessEnv, connect?: () => Promise<object|null>, timeoutMs?: number}} o
 * @returns {Promise<object>} stdout 에 찍을 객체
 */
export async function runStopHook({
  agent,
  input = "",
  cwd = process.cwd(),
  home = pluriplyHome(),
  env = process.env,
  connect,
  timeoutMs = 2000,
}) {
  if (!HOOK_AGENTS.includes(agent)) return {};
  // 워커 자식이 대화형 세션의 알림을 가로채면 안 된다(허브가 spawn 시 심는 표식, 스펙 §3).
  if (env.PLURIPLY_WORKER_TASK) return {};
  // Antigravity IDE 는 agy 훅과 같은 --agent antigravity 명령을 심으므로, IDE가 스폰한
  // 프로세스는 antigravity-ide 전용 어댑터에게 맡기고 여기서는 조용히 빠진다.
  if (resolveAgentName(agent, env) !== agent) return {};
  const data = parseInput(input);
  // stop_hook_active 는 Claude Code/Codex 만 보낸다 — antigravity 페이로드엔 없어 자연히 무시된다.
  if (data.stop_hook_active === true) return {};
  // Claude Code 는 세션 도중 cd 로 옮겨 다녀도 프로젝트 루트를 CLAUDE_PROJECT_DIR 로 계속
  // 알려준다(stdin의 cwd 는 그 순간의 작업 폴더라 어긋날 수 있다) — 실기기 확인, 2026-09-16.
  // antigravity 는 cwd 대신 workspacePaths 배열의 첫 항목을 보낸다.
  const at =
    agent === "claude-code" &&
    typeof env.CLAUDE_PROJECT_DIR === "string" &&
    env.CLAUDE_PROJECT_DIR.length > 0
      ? env.CLAUDE_PROJECT_DIR
      : agent === "antigravity"
        ? (Array.isArray(data.workspacePaths) &&
            typeof data.workspacePaths[0] === "string" &&
            data.workspacePaths[0]) ||
          cwd
        : typeof data.cwd === "string" && data.cwd.length > 0
          ? data.cwd
          : cwd;
  const doConnect =
    connect ??
    (async () => {
      const { connectIfLive } = await import("../connector/hub-client.js");
      return connectIfLive({ home });
    });
  let client = null;
  let timer;
  let settled = false;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      settled = true;
      resolve(null);
    }, timeoutMs);
  });
  try {
    const work = (async () => {
      client = await doConnect();
      if (!client) return null;
      // 데드라인이 이미 지난 뒤에야 연결됐다: 아무도 기다리지 않는 요청을 보내는 대신
      // 바로 닫는다(연결이 새고 늦은 응답·거부가 붕 뜨는 것을 막는다).
      if (settled) {
        try {
          client.close();
        } catch {
          // 닫기 실패는 무시
        }
        return null;
      }
      return client.request(
        "hook.poll",
        { tool: agent, cwd: at },
        { timeoutMs },
      );
    })();
    work.catch(() => {}); // 위 race 가 이미 끝난 뒤의 거부가 미처리로 남지 않게
    const r = await Promise.race([work, deadline]);
    if (!r || !r.channelCode) return {};
    if ((r.incoming?.length ?? 0) + (r.results?.length ?? 0) === 0) return {};
    const reason = formatStopReason({ ...r, cwd: at });
    // antigravity 는 {decision:"continue"} 라야 멈추지 않고 reason 을 주입한다(실기기 확인).
    // 다른 도구는 그대로 block.
    return agent === "antigravity"
      ? { decision: "continue", reason }
      : { decision: "block", reason };
  } catch (err) {
    if (process.env.PLURIPLY_HOOK_DEBUG === "1")
      process.stderr.write(`pluriply hook: ${err.message}\n`);
    return {};
  } finally {
    clearTimeout(timer);
    try {
      client?.close();
    } catch {
      // 닫기 실패는 무시
    }
  }
}
