import { z } from "zod";

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
    },
    { duringReconnect },
  );
  return r.instanceId;
}

/**
 * Pluriply MCP 도구를 등록한다.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('./hub-client.js').HubClient} hub
 * @param {{agent: string, instanceId: string|null}} identity instanceId 는 구버전 허브로 시작하면 null 이다.
 */
export function registerTools(server, hub, { agent, instanceId }) {
  /** instanceId 는 재접속 hello 가 돌려준 값으로 갱신된다(구버전 허브로 시작해 null 이었던 경우). */
  const state = { currentChannel: null, instanceId };
  const worker = Boolean(process.env.PLURIPLY_WORKER_TASK);
  /** 워커는 자기 태스크 깊이 + 1, 대화형 세션은 0 */
  const delegationDepth = () =>
    worker ? Number(process.env.PLURIPLY_DEPTH ?? 0) + 1 : 0;

  /**
   * 채널이 없을 때 허브에 직전 채널 복귀를 요청한다.
   * @returns {Promise<string|null>} 복귀한 채널 코드
   */
  async function resumeChannel() {
    const { channelCode } = await hub.request("agent.resume", {});
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
    const deadline = Date.now() + waitS * 1000;
    let task = null;
    let lastProgress = -1;
    try {
      while (!signal?.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const timeoutMs = Math.min(ASK_CHUNK_MS, remaining);
        ({ task } = await hub.request(
          "task.wait",
          { channelCode: code, taskId, timeoutMs },
          { timeoutMs: timeoutMs + 5000 },
        ));
        if (FINAL_TASK.has(task.status))
          return { status: task.status, taskId, result: task.result };
        if (progressToken !== undefined && extra?.sendNotification) {
          const elapsed = Math.min(
            waitS,
            Math.round((waitS * 1000 - (deadline - Date.now())) / 1000),
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
        state.instanceId = await hello(hub, {
          agent,
          worker,
          instanceId: state.instanceId,
          duringReconnect: true,
        });
        if (!state.currentChannel) return;
        await hub.request(
          "channel.join",
          { channelCode: state.currentChannel },
          { duringReconnect: true },
        );
        hub.emit("rejoined", state.currentChannel);
      } catch {
        // 채널이 사라졌으면 다음 도구 호출이 알려준다
      }
    });
  }

  server.registerTool(
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
          channel_code ?? (await hub.request("channel.create")).channelCode;
        const { peers } = await hub.request("channel.join", {
          channelCode: code,
        });
        state.currentChannel = code;
        return ok({ channelCode: code, peers, me: state.instanceId });
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    "list_peers",
    {
      annotations: annotations({ readOnlyHint: true, idempotentHint: true }),
      description:
        "List the AI tools connected to the joined channel. Each entry is one session (instanceId); the same tool may appear several times.",
      inputSchema: {},
    },
    needChannel((_args, code) =>
      hub.request("channel.peers", { channelCode: code }),
    ),
  );

  server.registerTool(
    "channel_status",
    {
      annotations: annotations({ readOnlyHint: true, idempotentHint: true }),
      description:
        "Show the joined channel code, its peers, and how many tasks await this agent.",
      inputSchema: {},
    },
    needChannel(async (_args, code) => {
      const { peers } = await hub.request("channel.peers", {
        channelCode: code,
      });
      const { tasks } = await hub.request("task.list", {
        channelCode: code,
        to: state.instanceId,
        status: "submitted",
      });
      const { running } = await hub.request("worker.status", {
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

  server.registerTool(
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
        "If targetJoined is false the target has not joined yet. Agent names are case-sensitive.",
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
      (
        { to, request, attachments = [], mode = "auto", cwd = process.cwd() },
        code,
      ) =>
        hub.request("task.create", {
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
  );

  server.registerTool(
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
        const created = await hub.request("task.create", {
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
          await hub
            .request("task.cancel", {
              channelCode: code,
              taskId,
              reason: "ask_agent: worker not started",
            })
            .catch(() => {});
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

  server.registerTool(
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
        const created = await hub.request("task.create", {
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
        if (wait_seconds === undefined) return created;
        const { taskId } = created;
        if (created.dispatch === "none") {
          await hub
            .request("task.cancel", {
              channelCode: code,
              taskId,
              reason: "request_review: worker not started",
            })
            .catch(() => {});
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

  server.registerTool(
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
      hub.request("task.cancel", {
        channelCode: code,
        taskId: task_id,
        reason,
      }),
    ),
  );

  server.registerTool(
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
        hub.request("task.list", {
          channelCode: code,
          to: sent_by_me ? undefined : mine_only ? state.instanceId : undefined,
          from: sent_by_me ? state.instanceId : undefined,
          status,
          kind,
        }),
    ),
  );

  server.registerTool(
    "get_task_result",
    {
      annotations: annotations({ readOnlyHint: true, idempotentHint: true }),
      description:
        "Fetch a task by id, including its status and result once completed.",
      inputSchema: { task_id: z.string() },
    },
    needChannel(({ task_id }, code) =>
      hub.request("task.get", { channelCode: code, taskId: task_id }),
    ),
  );

  server.registerTool(
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
      const { task } = await hub.request("task.get", {
        channelCode: code,
        taskId: task_id,
      });
      if (task.status === "submitted") {
        await hub.request("task.claim", {
          channelCode: code,
          taskId: task_id,
        });
      }
      return hub.request("task.complete", {
        channelCode: code,
        taskId: task_id,
        result,
        status: failed ? "failed" : "completed",
      });
    }),
  );

  server.registerTool(
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
      const { task } = await hub.request("task.get", {
        channelCode: code,
        taskId: task_id,
      });
      if (task.status === "submitted") {
        await hub.request("task.claim", { channelCode: code, taskId: task_id });
      }
      return hub.request("task.complete", {
        channelCode: code,
        taskId: task_id,
        status: "completed",
        review: { verdict, findings, summary },
      });
    }),
  );

  server.registerTool(
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
      hub.request("context.add", {
        channelCode: code,
        summary,
        artifacts,
      }),
    ),
  );

  server.registerTool(
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
      hub.request("context.list", { channelCode: code, limit }),
    ),
  );
}
