// Stop 훅 명령의 본체(스펙 §3·§5). 도구가 턴을 끝낼 때 불려 허브에 "나에게 온 것"을 묻고,
// 있으면 {"decision":"block","reason":…} 으로 세션이 이어서 일하게 한다. 어떤 경우에도 {} 로
// 조용히 끝나야 한다 — 훅이 도구를 방해하면 안 된다.
// 공개 미러에도 실리므로 허브·커넥터는 쓰는 순간에만 동적으로 불러온다(경계 테스트).
import { spawnSync } from "node:child_process";
import { pluriplyHome } from "../shared/paths.js";
import { resolveAgentName } from "../shared/identity.js";
import { formatActivity } from "../shared/activity-format.js";

export const HOOK_AGENTS = ["claude-code", "codex", "antigravity"];

/** 훅이 허브에 보내는 부모 pid 사슬의 길이 상한(Plan 6d §5) — 훅 → 셸 → 도구 → … 를 넉넉히 덮는다 */
export const HOST_PID_DEPTH = 6;
/** `ps` 실행 제한(ms) — 훅의 2초 기한 안에서 */
const PS_TIMEOUT_MS = 1000;

/**
 * `ps -A -o pid=,ppid=` 출력을 pid → ppid 표로 만든다. 숫자 둘이 아닌 줄은 건너뛴다.
 * @param {string} text @returns {Map<number, number>}
 */
export function parsePsTable(text) {
  const table = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (m) table.set(Number(m[1]), Number(m[2]));
  }
  return table;
}

/**
 * start 부터 부모를 따라 올라간 pid 목록(가까운 쪽부터, start 포함). pid 1 이하·표에 없는 pid·순환에서
 * 끊고 depth 개까지만.
 * @param {number} start @param {Map<number, number>} parentOf @param {number} [depth]
 * @returns {number[]}
 */
export function parentChain(start, parentOf, depth = HOST_PID_DEPTH) {
  const out = [];
  let pid = start;
  while (
    out.length < depth &&
    Number.isInteger(pid) &&
    pid > 1 &&
    !out.includes(pid)
  ) {
    out.push(pid);
    pid = parentOf.get(pid);
  }
  return out;
}

/**
 * 이 훅을 띄운 프로세스부터의 부모 pid 사슬(Plan 6d §5). 훅이 셸을 거쳐 실행되면 부모가 셸이라 도구
 * 프로세스(커넥터의 hostPid)가 사슬의 두세 번째에 있다 — 허브가 가까운 단계부터 맞춘다. POSIX 는 `ps` 를
 * 한 번 실행해 표에서 따라가고, Windows·실행 실패·기한 초과·빈 결과는 조용히 `[ppid]`.
 * @param {{ppid?: number, platform?: string, exec?: typeof spawnSync}} [o]
 * @returns {number[]}
 */
export function hostPidChain({
  ppid = process.ppid,
  platform = process.platform,
  exec = spawnSync,
} = {}) {
  if (platform === "win32") return [ppid];
  try {
    const r = exec("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
    });
    if (r.status !== 0 || typeof r.stdout !== "string") return [ppid];
    const chain = parentChain(ppid, parsePsTable(r.stdout));
    return chain.length > 0 ? chain : [ppid];
  } catch {
    return [ppid];
  }
}

/** 허브 hook.poll 응답을 모델이 읽을 문구로 만든다(공유 함수의 옛 이름, 호환용). */
export { formatActivity as formatStopReason };

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
 * @param {{agent: string, input?: string, cwd?: string, home?: string, env?: NodeJS.ProcessEnv, connect?: () => Promise<object|null>, timeoutMs?: number, hostPids?: () => number[]}} o
 *   hostPids 는 부모 pid 사슬을 주는 함수(기본 hostPidChain, 테스트가 바꾼다)
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
  hostPids = hostPidChain,
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
  // 부모 사슬은 연결·데드라인 전에 한 번 구한다 — ps(최대 PS_TIMEOUT_MS)가 훅의 응답 기한을 깎지 않게
  const chain = hostPids();
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
      // sessionId: 도구의 세션(Codex 는 스레드) ID — 허브가 짝지은 세션에 보관해 `pluriply codex`
      // 세션을 codex queue 로 깨운다(Plan 5b).
      const sessionId =
        typeof data.session_id === "string" && data.session_id.length > 0
          ? data.session_id
          : undefined;
      return client.request(
        "hook.poll",
        // hostPid: 이 훅을 띄운 도구 프로세스. 같은 세션의 커넥터도 그 자식이라(Claude Code·Codex
        // 실측) 허브가 어느 인스턴스의 훅인지 가려 그 세션 몫만 준다. 환경 변수(CLAUDE_PID 등)는
        // 도구 안에서 다른 도구를 띄우면 상속돼 믿을 수 없다.
        // hostPids(Plan 6d §5): 부모 사슬 — 훅이 셸을 거쳐 실행돼 부모가 셸이어도 허브가 도구 프로세스를
        // 찾는다. 옛 허브는 이 필드를 무시한다(프로토콜 11 그대로).
        {
          tool: agent,
          cwd: at,
          hostPid: process.ppid,
          hostPids: chain,
          ...(sessionId ? { sessionId } : {}),
        },
        { timeoutMs },
      );
    })();
    work.catch(() => {}); // 위 race 가 이미 끝난 뒤의 거부가 미처리로 남지 않게
    const r = await Promise.race([work, deadline]);
    if (!r || !r.channelCode) return {};
    if (
      (r.incoming?.length ?? 0) +
        (r.results?.length ?? 0) +
        (r.stalled?.length ?? 0) ===
      0
    )
      return {};
    const reason = formatActivity({ ...r, cwd: at });
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
