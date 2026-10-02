import { z } from "zod";
import { makeWaitForActivity, waitLimits } from "./wait.js";
import {
  threadIdFromExtra,
  codexWakeEnabled,
  startCodexWake,
  runCodexQueue,
} from "./codex-wake.js";
import { codeFingerprint, installRoot } from "../shared/fingerprint.js";
import { PACKAGE_VERSION } from "../shared/version.js";
import { makeVersionCheck } from "./version-check.js";

const CODE_ROOT = installRoot();
const START_CODE = codeFingerprint(CODE_ROOT, "connector");
/**
 * 이 커넥터 프로세스가 기동 때 읽은 코드(Plan 6a) — hello 로 허브에 알리고, 도구 응답 경고의 기준이다.
 * startedAt 은 재접속해도 바뀌지 않는다.
 */
export const CONNECTOR_CODE = {
  version: START_CODE?.version ?? PACKAGE_VERSION,
  fingerprint: START_CODE?.fingerprint ?? null,
  root: CODE_ROOT,
  startedAt: new Date().toISOString(),
};

/** @param {object} data @returns {object} MCP 텍스트 결과 */
function ok(data) {
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

/**
 * MCP 도구 annotations. 클라이언트(특히 codex)는 annotations 가 없는 도구를 "파괴적·외부 접근"으로
 * 간주해 비대화 실행에서 승인을 요구한다(readOnlyHint=false, destructiveHint=true 가 기본값).
 * pluriply 도구는 전부 로컬 허브만 건드리고 되돌릴 수 있으므로 기본을 비파괴·로컬로 두고,
 * 읽기 전용 도구만 readOnlyHint 를 켠다.
 * @param {object} [o] @returns {object}
 */
function annotations(o = {}) {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    ...o,
  };
}

/** @param {string} message @returns {object} MCP 에러 결과 */
function fail(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

const ASK_DEFAULT_WAIT_S = 50;
const ASK_MAX_WAIT_S = 300;
/** task.wait 한 번의 최대 보류 시간. 허브 상한(15초)보다 짧게 둬 요청 타임아웃과 겹치지 않게 한다. */
const ASK_CHUNK_MS = 10_000;
const FINAL_TASK = new Set(["completed", "failed", "cancelled"]);

/** @param {unknown} v @returns {number} 숫자가 아니면 기본 50, 1~300 으로 클램프 */
export function clampWaitSeconds(v) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return ASK_DEFAULT_WAIT_S;
  return Math.min(Math.max(n, 1), ASK_MAX_WAIT_S);
}

/** @param {{version: string, pid: number}} stale @returns {string} */
function staleHubMessage(stale) {
  return (
    `Pluriply hub is running an older version (${stale.version}, pid ${stale.pid}). ` +
    "Run `pluriply hub restart` to upgrade; other sessions attached to that hub will need to restart their tool."
  );
}

/** 허브가 hello 하지 않은 연결의 요청을 거절할 때 쓰는 문구(server.js #conn) */
const UNIDENTIFIED = "say hello first";

/** 채널 문서가 없을 때의 허브 오류(channels.js ChannelNotFound) */
const CHANNEL_GONE = /^channel not found: /;

/**
 * hub-client 자신이 내는 연결 오류(허브의 거절이 아니다). 원인이 정체성이 아니므로 "정체성을
 * 잃었다"로 감싸지 않고 원래 오류를 그대로 알린다: 끊김·시간 초과는 재접속 리스너가 곧
 * 되살리고, unreachable(dead)은 이미 원인(예: unauthorized)과 재시작 안내를 담고 있다.
 */
const HUB_CLIENT_ERROR =
  /^hub (connection closed|connection error|request timed out|unreachable)/;

/** 정체성을 되살리지 못했다 — 도구를 다시 시작해야 한다(안내 문구를 다른 안내로 감싸지 않게 구분한다) */
class IdentityLostError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(
      `Pluriply lost this session's identity on the hub connection and could not restore it (${reason}). ` +
        "Restart this AI tool (or reload its MCP server) to reconnect.",
    );
  }
}

/**
 * 허브에 정체성을 알리고 인스턴스 ID를 받는다. 재접속 때는 알고 있는 ID를 실어 그대로 인정받는다.
 * @param {import('./hub-client.js').HubClient} hub
 * @param {{agent: string, worker?: boolean, instanceId?: string|null, duringReconnect?: boolean}} opts
 * @returns {Promise<string>}
 */
export async function hello(
  hub,
  { agent, worker = false, instanceId, duringReconnect = false },
) {
  const r = await hub.request(
    "agent.hello",
    // null 을 그대로 보내면 허브가 "invalid instanceId: null" 로 거절한다(undefined 만 "새로 발급"이다).
    // 구버전 허브로 시작해 정체성이 없던 커넥터가 재접속 때 새 id 를 받을 수 있게 비운다.
    {
      tool: agent,
      cwd: process.cwd(),
      worker,
      instanceId: instanceId ?? undefined,
      // 커넥터를 띄운 도구 프로세스 — 같은 세션의 Stop 훅이 같은 값을 보내 허브가 짝을 찾는다
      hostPid: process.ppid,
      // Plan 6a: 이 커넥터의 코드 — status 가 옛 코드로 도는 세션을 가린다
      version: CONNECTOR_CODE.version,
      fingerprint: CONNECTOR_CODE.fingerprint ?? undefined,
      root: CONNECTOR_CODE.root,
      startedAt: CONNECTOR_CODE.startedAt,
      wake: codexWakeEnabled({ agent, env: process.env, stale: hub.stale }),
    },
    { duringReconnect },
  );
  // 허브의 코드(Plan 6a) — 도구 응답 경고가 허브가 옛 코드인지 판정한다. 옛 허브는 없다.
  hub.hubInfo = r.hub ?? null;
  return r.instanceId;
}

/**
 * Pluriply MCP 도구를 등록한다.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('./hub-client.js').HubClient} hub
 * @param {{agent: string, instanceId: string|null, env?: NodeJS.ProcessEnv, queue?: typeof runCodexQueue, wakeChunkMs?: number, versionCheck?: () => string[], log?: (line: string) => void}} identity instanceId 는 구버전 허브로 시작하면 null 이다. env·queue·wakeChunkMs·versionCheck 는 테스트가 주입한다(wakeChunkMs 는 startCodexWake 의 agent.wait 청크 길이 — 기본값은 undefined 로 두어 startCodexWake 자신의 기본값(WAKE_CHUNK_MS)을 쓴다).
 * @returns {{stopWake(): void}}
 */
export function registerTools(
  server,
  hub,
  {
    agent,
    instanceId,
    env = process.env,
    queue = runCodexQueue,
    wakeChunkMs,
    versionCheck,
    log = (line) => process.stderr.write(line),
  },
) {
  /** instanceId 는 재접속 hello 가 돌려준 값으로 갱신된다(구버전 허브로 시작해 null 이었던 경우). */
  const state = { currentChannel: null, instanceId, threadId: null };
  const worker = Boolean(process.env.PLURIPLY_WORKER_TASK);
  // Plan 5b: `pluriply codex` 세션이면 codex queue 로 스스로 깨운다
  const autoWake = codexWakeEnabled({ agent, env, stale: hub.stale });
  /**
   * Plan 6c §3.2: 깨우기 상태 보고는 codex 대화형 커넥터만 한다. 허브가 session.report 를 모르면
   * (프로토콜 < 11 — hello 응답의 hub.protocol 로 가린다) 보내지 않는다.
   */
  const reportsWake = agent === "codex" && !worker;
  const hubKnowsReports = () => (hub.hubInfo?.protocol ?? 1) >= 11;
  /** @type {{wakeState: string, reason?: string}|null} 마지막 보고 — 허브가 재시작되면 다시 알린다 */
  let lastReport = null;
  /**
   * 허브에 이 세션의 깨우기 상태를 알린다. 실패는 커넥터 동작을 바꾸지 않는다(stderr 한 줄).
   * @param {{wakeState: "on"|"off"|"failed", reason?: string, returned?: string[]}} payload
   */
  async function reportWakeState(payload) {
    if (!reportsWake || !hubKnowsReports()) return;
    lastReport = { wakeState: payload.wakeState };
    if (payload.reason) lastReport.reason = payload.reason;
    try {
      await hubRequest("session.report", payload);
    } catch (err) {
      log(
        `pluriply: could not report the wake state to the hub (${err.message})\n`,
      );
    }
  }
  // Plan 6a §7: 옛 코드 경고(워커는 수명이 짧아 경고하지 않는다)
  const codeWarnings = worker
    ? () => []
    : (versionCheck ??
      makeVersionCheck({
        self: CONNECTOR_CODE,
        hubInfo: () => hub.hubInfo ?? null,
      }));
  /**
   * 도구를 등록하되, 호출마다 Codex 가 _meta 에 싣는 스레드 ID 를 기록하고, 결과 끝에
   * 옛 코드 경고를 덧붙인다(Plan 6a §7). 첫 항목(JSON)은 건드리지 않는다 — 결과를 파싱하는
   * 쪽이 영향을 받지 않게 한다.
   */
  const register = (name, def, handler) =>
    server.registerTool(name, def, async (...a) => {
      const tid = threadIdFromExtra(a[a.length - 1]);
      if (tid) state.threadId = tid;
      const result = await handler(...a);
      let lines = [];
      try {
        lines = codeWarnings();
      } catch {
        // 경고 확인은 결과에 영향이 없다
      }
      if (lines.length === 0 || !Array.isArray(result?.content)) return result;
      return {
        ...result,
        content: [
          ...result.content,
          // 줄바꿈으로 시작한다 — Claude Code 는 content 항목을 이어 붙여 보여 JSON 끝에 붙어 버린다(실기기)
          ...lines.map((text) => ({ type: "text", text: `\n${text}` })),
        ],
      };
    });
  /** 워커는 자기 태스크 깊이 + 1, 대화형 세션은 0 */
  const delegationDepth = () =>
    worker ? Number(process.env.PLURIPLY_DEPTH ?? 0) + 1 : 0;

  /** 이 소켓에 알고 있는 instanceId 로 정체성을 다시 알린다 @param {{duringReconnect?: boolean}} [opts] */
  async function helloAgain(opts = {}) {
    state.instanceId = await hello(hub, {
      agent,
      worker,
      instanceId: state.instanceId,
      ...opts,
    });
  }

  /**
   * 참여 중이던 채널에 이 소켓으로 다시 들어간다.
   * @param {{duringReconnect?: boolean}} [opts] @returns {Promise<boolean>} 채널이 없으면 false
   */
  async function rejoin(opts = {}) {
    if (!state.currentChannel) return false;
    await hub.request(
      "channel.join",
      { channelCode: state.currentChannel },
      opts,
    );
    return true;
  }

  /** 진행 중인 정체성 복구. 동시에 거절된 요청들이 hello 하나를 같이 기다린다. */
  let recovering = null;
  /**
   * 이 소켓의 정체성이나 채널 참여가 빠졌다고 알고 있는 상태(재접속·복구의 hello 또는 재참여가
   * 실패했다). 조회 도구가 쓰는 허브 요청(channel.peers·task.list 등)은 정체성·참여 없이도
   * 통과하므로, 거절을 기다리면 복구가 일어나지 않고 이 인스턴스가 동료에게 offline 으로 남는다
   * (이 도구로 오는 태스크도 대화형 세션 대신 워커로 갈 수 있다) — 그래서 요청 전에 먼저 복구한다.
   * hello 와 재참여가 모두 끝나야 내린다: 끝나 가는 복구를 재사용하는 사이 재접속이 끼어도
   * 표시가 잘못 내려가지 않는다.
   */
  let needsRecover = false;

  /**
   * 참여 중이던 채널에 다시 들어가고 결과를 상태에 반영한다.
   * - 채널이 사라졌으면 currentChannel 을 비워 다음 호출이 자동 복귀·"Join a channel first" 로
   *   알리게 한다(기다리는 사이 join_channel 이 다른 채널로 바꿨으면 그대로 둔다).
   * - 연결 오류(끊김 등)나, 복구 도중 재접속이 끼어 아직 정체성 없는 새 소켓으로 나간 경우
   *   ("say hello first")는 다시 보내면 되므로 needsRecover 로 남겨 다음 호출이 다시 시도한다.
   * - 그 밖의 거절(예: 손상된 채널 문서)은 다시 보내도 같으니 표시를 내린다 — 남기면 세션 내내
   *   요청마다 왕복이 붙는다. 채널은 유지해 이후 요청이 실제 오류를 보이게 한다.
   * @param {{duringReconnect?: boolean}} [opts] @returns {Promise<boolean>} 다시 들어갔으면 true
   */
  async function restoreChannel(opts) {
    const code = state.currentChannel;
    try {
      const joined = await rejoin(opts);
      needsRecover = false;
      return joined;
    } catch (err) {
      if (CHANNEL_GONE.test(err.message)) {
        if (state.currentChannel === code) state.currentChannel = null;
        needsRecover = false;
      } else
        needsRecover =
          HUB_CLIENT_ERROR.test(err.message) || err.message === UNIDENTIFIED;
      return false;
    }
  }

  /**
   * 정체성을 되살리고 참여 중이던 채널에 다시 들어간다(hello 는 연결당 멱등).
   * 재접속 리스너는 이 공유 promise 를 쓰면 안 된다 — 여기서 나가는 요청은 재접속 배리어를
   * 기다리고, 배리어는 리스너가 끝나기를 기다리므로 서로를 기다리는 교착이 된다.
   * @returns {Promise<void>} hello 가 허브에 거절되면 IdentityLostError, 연결 오류면 그 오류 그대로
   */
  function recover() {
    recovering ??= (async () => {
      try {
        await helloAgain();
      } catch (err) {
        needsRecover = true;
        if (HUB_CLIENT_ERROR.test(err.message)) throw err;
        throw new IdentityLostError(err.message);
      }
      await restoreChannel();
    })().finally(() => {
      recovering = null;
    });
    return recovering;
  }

  /**
   * hub.request 와 같되 이 소켓의 정체성을 지킨다. 정체성·참여가 빠진 것을 알면 보내기 전에
   * 복구하고(재참여가 계속 실패하면 두 번까지만 — 요청은 그대로 보내고 다음 호출이 다시 시도한다),
   * 허브가 "say hello first" 로 거절하면 복구한 뒤 한 번만 다시 보낸다. 허브는 정체성이 필요한
   * 요청을 첫 줄(#conn)에서 거절하므로 다시 보내도 중복 부작용이 없다.
   * 재접속 리스너의 duringReconnect 요청은 이 경로를 타지 않는다.
   * @type {typeof hub.request}
   */
  async function hubRequest(type, payload, opts) {
    for (let i = 0; needsRecover && i < 2; i++) await recover();
    try {
      return await hub.request(type, payload, opts);
    } catch (err) {
      if (err.message !== UNIDENTIFIED) throw err;
    }
    await recover();
    try {
      return await hub.request(type, payload, opts);
    } catch (err) {
      if (err.message === UNIDENTIFIED)
        throw new IdentityLostError(err.message);
      throw err;
    }
  }

  /** 위임 응답의 깨우기 안내: Claude Code 는 wait_for_activity(Plan 5a D5), `pluriply codex` 는 자동(Plan 5b) */
  const withNotify = (data) =>
    autoWake
      ? {
          ...data,
          notify:
            "This session will be woken automatically when the result arrives.",
        }
      : agent === "claude-code"
        ? {
            ...data,
            notify:
              "Call wait_for_activity to be woken when the result arrives.",
          }
        : data;

  /**
   * 채널이 없을 때 허브에 직전 채널 복귀를 요청한다.
   * @returns {Promise<string|null>} 복귀한 채널 코드
   */
  async function resumeChannel() {
    const { channelCode } = await hubRequest("agent.resume", {});
    if (!channelCode) return null;
    if (state.currentChannel) return null; // join_channel이 경합에서 이겼으니 그대로 둔다
    state.currentChannel = channelCode;
    return channelCode;
  }

  /**
   * 채널 가드. 핸들러는 순수 데이터를 반환하고 여기서 MCP 결과로 포장한다.
   * 채널이 없으면 복귀를 시도하고, 복귀한 그 응답에만 resumedChannel을 붙인다.
   */
  const needChannel = (fn) => async (args, extra) => {
    if (hub.stale) return fail(staleHubMessage(hub.stale));
    let resumed = null;
    if (!state.currentChannel) {
      try {
        resumed = await resumeChannel();
      } catch (err) {
        // join_channel 도 같은 이유로 실패하므로 그쪽을 권하지 않고 재시작 안내만 낸다
        if (err instanceof IdentityLostError) return fail(err.message);
        return fail(
          `Join a channel first with join_channel. (auto-resume failed: ${err.message})`,
        );
      }
    }
    if (!state.currentChannel)
      return fail("Join a channel first with join_channel.");
    try {
      const data = await fn(args, state.currentChannel, extra);
      return ok(resumed ? { ...data, resumedChannel: resumed } : data);
    } catch (err) {
      return fail(
        resumed
          ? `${err.message} (channel ${resumed} was resumed automatically)`
          : err.message,
      );
    }
  };

  /**
   * task.wait 를 반복하며 최종 상태를 기다린다(ask_agent·request_review 공용).
   * @returns {Promise<{status: string, taskId: string, result?: unknown, taskStatus?: string, hint?: string}>}
   */
  async function waitForTask({ code, taskId, waitS, extra, label }) {
    const signal = extra?.signal;
    const progressToken = extra?._meta?.progressToken;
    const deadline = performance.now() + waitS * 1000;
    let task = null;
    let lastProgress = -1;
    try {
      while (!signal?.aborted) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        const timeoutMs = Math.min(ASK_CHUNK_MS, remaining);
        ({ task } = await hubRequest(
          "task.wait",
          { channelCode: code, taskId, timeoutMs },
          { timeoutMs: timeoutMs + 5000 },
        ));
        if (FINAL_TASK.has(task.status))
          return { status: task.status, taskId, result: task.result };
        if (progressToken !== undefined && extra?.sendNotification) {
          const elapsed = Math.min(
            waitS,
            Math.round((waitS * 1000 - (deadline - performance.now())) / 1000),
          );
          if (elapsed > lastProgress) {
            lastProgress = elapsed;
            await extra
              .sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: elapsed,
                  total: waitS,
                  message: `waiting for ${label} (task ${taskId})`,
                },
              })
              .catch(() => {});
          }
        }
      }
    } catch (err) {
      throw new Error(
        `${err.message} (task ${taskId} may still be running; use get_task_result or list_tasks with sent_by_me: true)`,
      );
    }
    return {
      status: "running",
      taskId,
      taskStatus: task?.status ?? "submitted",
      hint: `still running; call get_task_result with task_id "${taskId}" (or cancel_task)`,
    };
  }

  // 허브가 재시작되면 정체성을 다시 알리고, 채널이 있으면 다시 참여한다 (hub-client가 reconnected를 낸다)
  if (typeof hub.on === "function") {
    hub.on("reconnected", async () => {
      try {
        // duringReconnect: true — 이 리스너 자체가 hub-client의 재접속 배리어이므로,
        // 여기서 나가는 request()가 this.reconnecting을 기다리면 자기 자신을
        // 기다리는 교착 상태가 된다.
        // 새 소켓은 정체성이 없으므로 채널 유무와 관계없이 먼저 hello로 인스턴스
        // ID를 다시 인정받아야 한다. 채널이 없다고 건너뛰면 이후의 자동 복귀·
        // join_channel이 도구를 다시 시작할 때까지 "say hello first"로 막힌다.
        // (hello는 인증이 필요한 요청이라, 토큰이 틀린 연결은 여기서 unauthorized를
        // 받아 hub-client의 재접속 판정이 그것을 본다.)
        // recover() 의 공유 promise 는 쓰지 않는다(교착 — recover 주석 참고).
        await helloAgain({ duringReconnect: true });
      } catch {
        // 다음 도구 호출이 요청을 보내기 전에 hubRequest() 에서 복구한다
        needsRecover = true;
        return;
      }
      // Plan 6c: 재시작한 허브는 이 세션의 깨우기 상태를 모른다(연결 단위 메모리) — 마지막 보고를 다시
      // 알린다. 되돌릴 태스크는 싣지 않는다(그 사이 같은 폴더 키로 다시 전달된 태스크를 되돌리면 안 된다).
      // hubRequest 가 아니라 hub.request(duringReconnect) — 이 리스너가 재접속 배리어다(위 주석).
      if (lastReport && hubKnowsReports())
        hub
          .request("session.report", lastReport, { duringReconnect: true })
          .catch((err) =>
            log(
              `pluriply: could not report the wake state to the hub (${err.message})\n`,
            ),
          );
      // 재참여 실패도 needsRecover 로 남기고, 채널이 사라졌으면 currentChannel 을 비운다
      if (await restoreChannel({ duringReconnect: true }))
        hub.emit("rejoined", state.currentChannel);
    });
  }

  register(
    "join_channel",
    {
      annotations: annotations({ idempotentHint: true }),
      description:
        "Join a Pluriply collaboration channel shared by your other AI tools. " +
        "Omit channel_code to create a new channel; share the returned code with other tools so they can join. " +
        "Calling this always overrides any automatically resumed channel." +
        " The response's me is your instanceId; other tools can pin tasks to it.",
      inputSchema: { channel_code: z.string().optional() },
    },
    async ({ channel_code }) => {
      if (hub.stale) return fail(staleHubMessage(hub.stale));
      try {
        const code =
          channel_code ?? (await hubRequest("channel.create")).channelCode;
        const { peers } = await hubRequest("channel.join", {
          channelCode: code,
        });
        state.currentChannel = code;
        return ok({ channelCode: code, peers, me: state.instanceId });
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  const waitForActivity = makeWaitForActivity({ hubRequest, agent });
  const waitForActivityChannel = needChannel((args, code, extra) =>
    waitForActivity(args, code, extra),
  );
  register(
    "wait_for_activity",
    {
      annotations: annotations({ readOnlyHint: true }),
      description:
        "Wait until something arrives for this session — tasks sent to you, results of tasks you sent, or notices that nobody picked up your task — and return a summary. " +
        (agent === "claude-code"
          ? "In Claude Code this call moves to the background after about 2 minutes and wakes this session when activity arrives: call it after delegating work or when the user asks you to listen, and call it again after handling what it returns. wait_seconds defaults to 43200 (max 86400)."
          : `In this tool the call blocks the session, so keep it short: wait_seconds defaults to ${waitLimits(agent).def} (max ${waitLimits(agent).max}). Stop hooks also report new activity at the end of each turn.`),
      inputSchema: { wait_seconds: z.number().optional() },
    },
    // worker 는 채널이 없어도 즉시 거절한다(needChannel 앞에서 검사 — 자동 복귀 왕복 없이).
    // `pluriply codex` 세션은 뒤의 깨우기 루프가 대기하므로 여기서 기다리지 않는다(Plan 5b §6.3).
    (args, extra) =>
      worker
        ? fail("wait_for_activity is for interactive sessions")
        : autoWake
          ? ok({
              status: "auto",
              next: "This Codex session is woken automatically when tasks or results arrive. End your turn instead of waiting.",
            })
          : waitForActivityChannel(args, extra),
  );

  register(
    "list_peers",
    {
      annotations: annotations({ readOnlyHint: true, idempotentHint: true }),
      description:
        "List the AI tools connected to the joined channel. Each entry is one session (instanceId); the same tool may appear several times.",
      inputSchema: {},
    },
    needChannel((_args, code) =>
      hubRequest("channel.peers", { channelCode: code }),
    ),
  );

  register(
    "channel_status",
    {
      annotations: annotations({ readOnlyHint: true, idempotentHint: true }),
      description:
        "Show the joined channel code, its peers, and how many tasks await this agent.",
      inputSchema: {},
    },
    needChannel(async (_args, code) => {
      const { peers } = await hubRequest("channel.peers", {
        channelCode: code,
      });
      const { tasks } = await hubRequest("task.list", {
        channelCode: code,
        to: state.instanceId,
        status: "submitted",
      });
      const { running } = await hubRequest("worker.status", {
        channelCode: code,
      });
      return {
        channelCode: code,
        peers,
        pendingTaskCount: tasks.length,
        runningWorkers: running,
      };
    }),
  );

  register(
    "send_task",
    {
      annotations: annotations(),
      description:
        'Delegate a task to another AI tool on the channel (e.g. to: "codex"). ' +
        "Returns a taskId; poll get_task_result with it to collect the outcome. " +
        "dispatch tells you what happened: interactive = a live session of that tool will handle it (ask the user to nudge it), " +
        "spawned/queued = the hub started a headless worker, none = nothing will process it (the hint says how to enable a worker). " +
        "pinned = the task is fixed to that instance (no worker will be spawned); targetOnline tells whether it is connected right now. " +
        "Always pass cwd as the folder the work should happen in. " +
        "If targetJoined is false the target has not joined yet. Agent names are case-sensitive. " +
        "The task's events (see get_task_result) record wake-failed or unclaimed when the target session did not receive it, " +
        "ignored when a session received it but ended its turn without a result, and to-worker when a worker took it over.",
      inputSchema: {
        to: z
          .string()
          .describe(
            'Target: a tool name (e.g. "codex") for any session of that tool, or an instanceId from list_peers (e.g. "codex#k7pq") to pin the task to one session',
          ),
        request: z
          .string()
          .describe(
            "What you want the other tool to do, with all needed context",
          ),
        attachments: z
          .array(z.string())
          .optional()
          .describe("Absolute file paths to share"),
        mode: z
          .enum(["auto", "spawn", "interactive"])
          .optional()
          .describe(
            "auto (default): spawn a worker only if no live session; spawn: always spawn; interactive: never spawn",
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            "Absolute working directory for the task (default: this session's cwd)." +
              " Must be inside this session's working directory or one of config.json allowedRoots.",
          ),
      },
    },
    needChannel(
      async (
        { to, request, attachments = [], mode = "auto", cwd = process.cwd() },
        code,
      ) =>
        withNotify(
          await hubRequest("task.create", {
            channelCode: code,
            to,
            request,
            attachments,
            mode,
            cwd,
            origin: process.cwd(),
            depth: delegationDepth(),
          }),
        ),
    ),
  );

  register(
    "ask_agent",
    {
      annotations: annotations(),
      description:
        'Ask another AI tool something and wait for the answer (e.g. to: "codex"). ' +
        "The hub always starts a headless worker of that tool (it must be enabled with `pluriply worker enable <tool>`), " +
        "regardless of live sessions. Waits up to wait_seconds (default 50, max 300) and returns status completed/failed/cancelled with result. " +
        "If it is still running you get status running plus taskId: call get_task_result later. " +
        "taskStatus on a running response (submitted/working) tells whether the worker has claimed the task yet. " +
        "status not_started means no worker could start (hint says why) and the task was cancelled. " +
        "Use send_task instead for long jobs or to pin a specific instance. Always pass cwd as the folder the work should happen in.",
      inputSchema: {
        to: z
          .string()
          .describe(
            'Tool name only (e.g. "codex", "antigravity"); instance ids are rejected',
          ),
        request: z
          .string()
          .describe("The question or task, with all needed context"),
        attachments: z
          .array(z.string())
          .optional()
          .describe("Absolute file paths to share"),
        cwd: z
          .string()
          .optional()
          .describe(
            "Absolute working directory for the worker (default: this session's cwd)." +
              " Must be inside this session's working directory or one of config.json allowedRoots.",
          ),
        wait_seconds: z
          .number()
          .optional()
          .describe(
            "How long to wait for the answer (default 50, max 300; keep under 60 when calling from Codex or Gemini)",
          ),
      },
    },
    needChannel(
      async (
        { to, request, attachments = [], cwd = process.cwd(), wait_seconds },
        code,
        extra,
      ) => {
        if (typeof to === "string" && to.includes("#"))
          throw new Error(
            `ask_agent takes a tool name (e.g. "codex"); use send_task to pin an instance like "${to}"`,
          );
        const waitS = clampWaitSeconds(wait_seconds);
        const created = await hubRequest("task.create", {
          channelCode: code,
          to,
          request,
          attachments,
          mode: "spawn",
          cwd,
          origin: process.cwd(),
          depth: delegationDepth(),
        });
        const { taskId } = created;
        if (created.dispatch !== "spawned" && created.dispatch !== "queued") {
          // 워커가 뜨지 않았다: 쓰레기 submitted 태스크를 남기지 않는다
          await hubRequest("task.cancel", {
            channelCode: code,
            taskId,
            reason: "ask_agent: worker not started",
          }).catch(() => {});
          return {
            status: "not_started",
            taskId,
            hint: created.hint ?? `dispatch: ${created.dispatch}`,
          };
        }
        return waitForTask({
          code,
          taskId,
          waitS,
          extra,
          label: `${to} worker`,
        });
      },
    ),
  );

  register(
    "request_review",
    {
      annotations: annotations(),
      description:
        "Ask another AI tool to review work in this project and return a structured verdict. " +
        'Target: git_range (e.g. "master..HEAD", "HEAD~3") and/or paths; neither means the uncommitted changes (git diff HEAD). ' +
        'focus sets the angle (e.g. "security", "quality"). The reviewer runs read-only. ' +
        "By default returns a taskId immediately (dispatch tells you who will review; poll get_task_result — result holds {verdict, findings[], summary}). " +
        "Pass wait_seconds (max 300) to wait like ask_agent: status completed comes with review, running comes with taskId. " +
        "to may be a tool name or an instanceId from list_peers. Always pass cwd as the project folder.",
      inputSchema: {
        to: z
          .string()
          .describe(
            'Tool name (e.g. "codex") or instanceId (e.g. "codex#k7pq")',
          ),
        request: z
          .string()
          .optional()
          .describe("Extra instructions for the reviewer"),
        git_range: z
          .string()
          .optional()
          .describe(
            'Git revision range to review, e.g. "master..HEAD" or "HEAD~1"',
          ),
        paths: z
          .array(z.string())
          .optional()
          .describe("Files or folders to review (absolute or relative to cwd)"),
        focus: z
          .string()
          .optional()
          .describe('Review angle, e.g. "security", "performance"'),
        cwd: z
          .string()
          .optional()
          .describe(
            "Absolute project folder (default: this session's cwd). Must be inside this session's working directory or one of config.json allowedRoots.",
          ),
        mode: z
          .enum(["auto", "spawn", "interactive"])
          .optional()
          .describe(
            "auto (default): spawn a worker only if no live session; spawn: always spawn; interactive: never spawn",
          ),
        wait_seconds: z
          .number()
          .optional()
          .describe(
            "If set, wait up to this many seconds (1-300) for the review",
          ),
      },
    },
    needChannel(
      async (
        {
          to,
          request,
          git_range,
          paths,
          focus,
          cwd = process.cwd(),
          mode = "auto",
          wait_seconds,
        },
        code,
        extra,
      ) => {
        const review = {};
        if (git_range !== undefined) review.gitRange = git_range;
        if (paths !== undefined) review.paths = paths;
        if (focus !== undefined) review.focus = focus;
        const created = await hubRequest("task.create", {
          channelCode: code,
          to,
          request: request ?? "",
          attachments: [],
          kind: "review",
          review,
          mode,
          cwd,
          origin: process.cwd(),
          depth: delegationDepth(),
        });
        if (wait_seconds === undefined) return withNotify(created);
        const { taskId } = created;
        if (created.dispatch === "none") {
          await hubRequest("task.cancel", {
            channelCode: code,
            taskId,
            reason: "request_review: worker not started",
          }).catch(() => {});
          return {
            status: "not_started",
            taskId,
            hint: created.hint ?? `dispatch: ${created.dispatch}`,
          };
        }
        const waited = await waitForTask({
          code,
          taskId,
          waitS: clampWaitSeconds(wait_seconds),
          extra,
          label: `${to} review`,
        });
        if (waited.status === "completed") {
          const { result, ...rest } = waited;
          return { ...rest, review: result };
        }
        return waited;
      },
    ),
  );

  register(
    "cancel_task",
    {
      annotations: annotations({ idempotentHint: true }),
      description:
        "Cancel a task you sent that has not finished yet. " +
        "Use it to clean up tasks sent to the wrong target or no longer needed. Only the sender can cancel.",
      inputSchema: {
        task_id: z.string(),
        reason: z.string().optional().describe("Why it was cancelled"),
      },
    },
    needChannel(({ task_id, reason }, code) =>
      hubRequest("task.cancel", {
        channelCode: code,
        taskId: task_id,
        reason,
      }),
    ),
  );

  register(
    "list_tasks",
    {
      annotations: annotations({ readOnlyHint: true, idempotentHint: true }),
      description:
        "List tasks on the channel. By default lists tasks addressed to me. " +
        'Set sent_by_me: true to list tasks I delegated (combine with status: "submitted" to find undelivered ones to cancel_task).',
      inputSchema: {
        status: z
          .enum(["submitted", "working", "completed", "failed", "cancelled"])
          .optional(),
        mine_only: z
          .boolean()
          .optional()
          .describe("Default true: only tasks addressed to me"),
        sent_by_me: z
          .boolean()
          .optional()
          .describe("Only tasks I sent; overrides mine_only"),
        kind: z
          .enum(["task", "review"])
          .optional()
          .describe("Only tasks of this kind"),
      },
    },
    needChannel(
      ({ status, mine_only = true, sent_by_me = false, kind }, code) =>
        hubRequest("task.list", {
          channelCode: code,
          to: sent_by_me ? undefined : mine_only ? state.instanceId : undefined,
          from: sent_by_me ? state.instanceId : undefined,
          status,
          kind,
          // 모델이 목록을 보았으니 제 몫의 태스크는 전달된 것으로 기록한다(Plan 5a)
          markDelivered: true,
        }),
    ),
  );

  register(
    "get_task_result",
    {
      annotations: annotations({ readOnlyHint: true, idempotentHint: true }),
      description:
        "Fetch a task by id, including its status and result once completed. " +
        "If its events include wake-failed or unclaimed, the target session did not receive it; " +
        "if they include ignored, the target session received it but ended its turn without a result. " +
        "Either way look for a to-worker event (a worker took it over); " +
        "otherwise resend it to another target or as a worker task (mode: spawn).",
      inputSchema: { task_id: z.string() },
    },
    needChannel(({ task_id }, code) =>
      hubRequest("task.get", { channelCode: code, taskId: task_id }),
    ),
  );

  register(
    "submit_result",
    {
      annotations: annotations({ idempotentHint: true }),
      description:
        "Submit the result for a task that was delegated to this agent. Review tasks must use submit_review (failed: true is still allowed here).",
      inputSchema: {
        task_id: z.string(),
        result: z
          .string()
          .describe(
            "The outcome: findings, produced file paths, or the deliverable itself",
          ),
        failed: z
          .boolean()
          .optional()
          .describe("Set true if the task could not be done"),
      },
    },
    needChannel(async ({ task_id, result, failed = false }, code) => {
      const { task } = await hubRequest("task.get", {
        channelCode: code,
        taskId: task_id,
      });
      if (task.status === "submitted") {
        await hubRequest("task.claim", {
          channelCode: code,
          taskId: task_id,
        });
      }
      return hubRequest("task.complete", {
        channelCode: code,
        taskId: task_id,
        result,
        status: failed ? "failed" : "completed",
      });
    }),
  );

  register(
    "submit_review",
    {
      annotations: annotations({ idempotentHint: true }),
      description:
        "Submit the outcome of a review task delegated to this agent. " +
        "verdict: approve (no critical/important findings), request_changes, or comment. " +
        "Each finding needs severity (critical|important|minor) and message; add file and line when they apply. " +
        "Review tasks cannot be completed with submit_result.",
      inputSchema: {
        task_id: z.string(),
        verdict: z.enum(["approve", "request_changes", "comment"]),
        findings: z
          .array(
            z.object({
              severity: z.enum(["critical", "important", "minor"]),
              file: z.string().optional(),
              line: z.number().int().positive().optional(),
              message: z.string(),
              suggestion: z.string().optional(),
            }),
          )
          .optional(),
        summary: z.string().describe("Short overall assessment"),
      },
    },
    needChannel(async ({ task_id, verdict, findings = [], summary }, code) => {
      const { task } = await hubRequest("task.get", {
        channelCode: code,
        taskId: task_id,
      });
      if (task.status === "submitted") {
        await hubRequest("task.claim", { channelCode: code, taskId: task_id });
      }
      return hubRequest("task.complete", {
        channelCode: code,
        taskId: task_id,
        status: "completed",
        review: { verdict, findings, summary },
      });
    }),
  );

  register(
    "share_update",
    {
      annotations: annotations(),
      description:
        "Record what you just did into the shared channel context so other tools stay aware.",
      inputSchema: {
        summary: z.string().describe("Short summary of the work done"),
        artifacts: z
          .array(z.string())
          .optional()
          .describe("Absolute file paths of produced artifacts"),
      },
    },
    needChannel(({ summary, artifacts = [] }, code) =>
      hubRequest("context.add", {
        channelCode: code,
        summary,
        artifacts,
      }),
    ),
  );

  register(
    "get_channel_context",
    {
      annotations: annotations({ readOnlyHint: true, idempotentHint: true }),
      description:
        "Read the shared work history of the channel: what every connected tool has done and produced.",
      inputSchema: {
        limit: z
          .number()
          .optional()
          .describe("Return only the latest N entries"),
      },
    },
    needChannel(({ limit }, code) =>
      hubRequest("context.list", { channelCode: code, limit }),
    ),
  );

  // Plan 5b: 깨우기 루프. 채널이 없으면 직전 채널로 돌아가 참여한 채 기다린다.
  const wake = autoWake
    ? startCodexWake({
        hubRequest,
        state,
        remote: env.PLURIPLY_CODEX_REMOTE,
        queue,
        chunkMs: wakeChunkMs,
        log,
        report: reportWakeState,
        prepare: async () => {
          if (!state.currentChannel) await resumeChannel();
        },
      })
    : null;
  // Plan 6c §3.2: 기동 때 한 번 깨우기 상태를 알린다 — 켜졌거나(on), 왜 꺼졌는지(off + 이유: 실행기가
  // 넘긴 앱 서버 실패 이유, 옛 허브, 평범한 codex). 기다리지 않는다(도구 등록을 막지 않게).
  if (reportsWake) {
    const reason = autoWake
      ? null
      : typeof env.PLURIPLY_CODEX_WAKE_ERROR === "string" &&
          env.PLURIPLY_CODEX_WAKE_ERROR.length > 0
        ? env.PLURIPLY_CODEX_WAKE_ERROR
        : hub.stale
          ? // 프로토콜 11 에서는 닿지 않는다: stale 허브(< 11)는 보고를 받지 않는다(hubKnowsReports). 12 부터 의미가 생긴다.
            "hub too old"
          : "not started with pluriply codex";
    void reportWakeState(
      autoWake ? { wakeState: "on" } : { wakeState: "off", reason },
    );
  }
  return {
    stopWake() {
      wake?.stop();
    },
  };
}
