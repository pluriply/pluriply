import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOST_PID_DEPTH,
  formatStopReason,
  hostPidChain,
  parentChain,
  parsePsTable,
  runStopHook,
} from "../../src/setup/hook-stop.js";

/** 테스트가 훅에 심는 부모 사슬(훅 → 셸 → 도구) */
const CHAIN = [4242, 4200, 4100];

const poll = {
  tool: "claude-code",
  cwd: "/repo",
  channelCode: "plp-ab12-cd34",
  incoming: [
    {
      taskId: "task_1",
      kind: "task",
      from: "codex#9f3e",
      summary: "Refactor the reconnect path",
    },
    {
      taskId: "task_2",
      kind: "review",
      from: "antigravity#77aa",
      summary: "Review server.js",
    },
  ],
  results: [
    {
      taskId: "task_3",
      status: "completed",
      to: "codex",
      summary: "Write tests",
    },
    {
      taskId: "task_4",
      status: "failed",
      to: "antigravity#77aa",
      summary: "Summarize",
    },
  ],
  more: 3,
};

test("formatStopReason renders both sections, skips empty ones, and caps length", () => {
  const text = formatStopReason(poll);
  assert.match(
    text,
    /^pluriply: new activity on channel plp-ab12-cd34 for claude-code \(cwd \/repo\)\. Handle it before finishing\.\n/,
  );
  assert.match(
    text,
    /Incoming tasks \(do the work, then submit_result — or submit_review for reviews; skip one another instance already claimed\):\n- task_1 task from codex#9f3e: "Refactor the reconnect path"\n- task_2 review from antigravity#77aa: "Review server.js"\n/,
  );
  assert.match(
    text,
    /Results of tasks you delegated \(read them with get_task_result\):\n- task_3 completed by codex: "Write tests"\n- task_4 failed by antigravity#77aa: "Summarize"\n/,
  );
  assert.match(text, /\(\+3 more: run list_tasks\)$/);
  const onlyIn = formatStopReason({ ...poll, results: [], more: 0 });
  assert.doesNotMatch(onlyIn, /Results of tasks/);
  assert.doesNotMatch(onlyIn, /more: run list_tasks/);
  // formatStopReason은 순수 함수라 요약을 줄이지 않는다(80자 컷은 허브가 한다) — 여기서
  // 2,000자 트림을 강제하려면 요약 자체를 길게 만들어야 한다.
  const big = formatStopReason({
    ...poll,
    incoming: Array.from({ length: 10 }, (_, i) => ({
      taskId: `task_${i}`,
      kind: "task",
      from: "codex#0000",
      summary: "x".repeat(300),
    })),
    results: [],
    more: 0,
  });
  assert.ok(big.length <= 2000, `length ${big.length}`);
  assert.match(big, /\(\+\d+ more: run list_tasks\)$/);
  // 항목이 10개(허브가 보내는 최대치)라도 합계가 2,000자를 넘지 않으면 트림하지 않는다
  const notTrimmed = formatStopReason({
    ...poll,
    incoming: Array.from({ length: 10 }, (_, i) => ({
      taskId: `task_${i}`,
      kind: "task",
      from: "codex#0000",
      summary: "x".repeat(80) + " tail",
    })),
    results: [],
    more: 0,
  });
  assert.doesNotMatch(notTrimmed, /more: run list_tasks/);
});

test("runStopHook answers {} without asking the hub when the agent is unknown, stop_hook_active is set, or the hub is down", async () => {
  let asked = 0;
  const connect = async () => {
    asked++;
    return null;
  };
  assert.deepEqual(
    await runStopHook({ agent: "nope", input: "{}", connect }),
    {},
  );
  assert.deepEqual(
    await runStopHook({
      agent: "claude-code",
      input: JSON.stringify({ stop_hook_active: true, cwd: "/x" }),
      connect,
    }),
    {},
  );
  assert.equal(asked, 0);
  assert.deepEqual(
    await runStopHook({
      agent: "codex",
      input: "not json",
      cwd: "/x",
      connect,
    }),
    {},
  );
  assert.equal(asked, 1);
});

test("runStopHook blocks with the reason when the hub has items, and swallows errors, old hubs and timeouts", async () => {
  const fake = (reply) => async () => ({
    request: async (type, payload) => {
      assert.equal(type, "hook.poll");
      // hostPid: 훅을 띄운 도구 프로세스 — 같은 세션의 커넥터도 그 자식이라 허브가 인스턴스를 가린다.
      // hostPids(Plan 6d): 그 위로의 부모 사슬 — 셸을 거친 훅도 도구를 찾는다
      const { sessionId: _s, ...rest } = payload;
      assert.deepEqual(rest, {
        tool: "codex",
        cwd: "/repo",
        hostPid: process.ppid,
        hostPids: CHAIN,
      });
      return typeof reply === "function" ? reply() : reply;
    },
    close() {
      this.closed = true;
    },
  });
  const ok = await runStopHook({
    agent: "codex",
    input: JSON.stringify({ cwd: "/repo", session_id: "s" }),
    connect: fake({ ...poll, tool: "codex" }),
    hostPids: () => CHAIN,
  });
  assert.equal(ok.decision, "block");
  assert.match(ok.reason, /task_1/);
  assert.deepEqual(
    await runStopHook({
      agent: "codex",
      input: JSON.stringify({ cwd: "/repo" }),
      connect: fake({
        channelCode: null,
        tool: "codex",
        incoming: [],
        results: [],
        more: 0,
      }),
    }),
    {},
  );
  assert.deepEqual(
    await runStopHook({
      agent: "codex",
      input: JSON.stringify({ cwd: "/repo" }),
      connect: fake(() => {
        throw new Error("unknown type: hook.poll");
      }),
    }),
    {},
  );
  assert.deepEqual(
    await runStopHook({
      agent: "codex",
      input: JSON.stringify({ cwd: "/repo" }),
      connect: fake(() => new Promise(() => {})),
      timeoutMs: 50,
    }),
    {},
  );
  assert.deepEqual(
    await runStopHook({
      agent: "codex",
      input: JSON.stringify({ cwd: "/repo" }),
      connect: async () => {
        throw new Error("boom");
      },
    }),
    {},
  );
});

test("runStopHook prefers CLAUDE_PROJECT_DIR for claude-code, falling back to stdin cwd without it", async () => {
  // request() 안에서 assert 가 던지면 runStopHook의 catch가 삼켜 {}로 나오므로, 실제로
  // 받은 cwd를 기록해 밖에서 비교한다(잘못된 cwd가 조용히 {}로 위장되지 않게).
  const seen = [];
  const fake = () => async () => ({
    request: async (type, payload) => {
      seen.push(payload.cwd);
      return { channelCode: null, incoming: [], results: [], more: 0 };
    },
    close() {},
  });
  await runStopHook({
    agent: "claude-code",
    input: JSON.stringify({ cwd: "/proj/sub", session_id: "a" }),
    env: { CLAUDE_PROJECT_DIR: "/proj" },
    connect: fake(),
  });
  await runStopHook({
    agent: "claude-code",
    input: JSON.stringify({ cwd: "/proj/sub", session_id: "a" }),
    env: {},
    connect: fake(),
  });
  // 빈 문자열은 없는 것으로 친다
  await runStopHook({
    agent: "claude-code",
    input: JSON.stringify({ cwd: "/proj/sub", session_id: "a" }),
    env: { CLAUDE_PROJECT_DIR: "" },
    connect: fake(),
  });
  assert.deepEqual(seen, ["/proj", "/proj/sub", "/proj/sub"]);
});

test("runStopHook stays quiet for a headless worker child so it never steals the interactive session's notifications", async () => {
  let asked = 0;
  const connect = async () => {
    asked++;
    return null;
  };
  assert.deepEqual(
    await runStopHook({
      agent: "codex",
      input: JSON.stringify({ cwd: "/repo" }),
      env: { PLURIPLY_WORKER_TASK: "task_x" },
      connect,
    }),
    {},
  );
  assert.equal(asked, 0);
});

test("runStopHook stays quiet for antigravity when the IDE spawned it (parity with the antigravity-ide hook file)", async () => {
  let asked = 0;
  const connect = async () => {
    asked++;
    return null;
  };
  assert.deepEqual(
    await runStopHook({
      agent: "antigravity",
      input: JSON.stringify({ conversationId: "c", workspacePaths: ["/ws"] }),
      env: {
        ANTIGRAVITY_EDITOR_APP_ROOT: "/Applications/Antigravity IDE.app",
      },
      connect,
    }),
    {},
  );
  assert.equal(asked, 0);
});

test("runStopHook closes a client that connects after the 2s deadline instead of sending it a request", async () => {
  let requested = false;
  let closed = false;
  const connect = () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          request: async () => {
            requested = true;
            throw new Error("too late — should never be called");
          },
          close() {
            closed = true;
          },
        });
      }, 60);
    });
  const r = await runStopHook({
    agent: "codex",
    input: JSON.stringify({ cwd: "/repo" }),
    connect,
    timeoutMs: 20,
  });
  assert.deepEqual(r, {});
  // 데드라인을 진 늦깎이 연결이 정리될 시간을 준다
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(closed, true);
  assert.equal(requested, false);
});

test("runStopHook blocks for a stalled notice even when there are no incoming tasks or results", async () => {
  const connect = async () => ({
    request: async () => ({
      channelCode: "plp-ab12-cd34",
      tool: "claude-code",
      incoming: [],
      results: [],
      stalled: [
        {
          taskId: "task_9",
          to: "codex",
          summary: "Port the parser",
          hint: "no live session picked it up within 120s; worker disabled",
        },
      ],
      more: 0,
    }),
    close() {},
  });
  const out = await runStopHook({
    agent: "claude-code",
    input: JSON.stringify({ cwd: "/repo" }),
    env: {},
    connect,
  });
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Waiting on others/);
});

test("runStopHook maps workspacePaths[0] for antigravity and answers decision continue", async () => {
  const fake = (reply) => async () => ({
    request: async (type, payload) => {
      assert.equal(type, "hook.poll");
      const { sessionId: _s, ...rest } = payload;
      assert.deepEqual(rest, {
        tool: "antigravity",
        cwd: "/ws",
        hostPid: process.ppid,
        hostPids: CHAIN,
      });
      return typeof reply === "function" ? reply() : reply;
    },
    close() {
      this.closed = true;
    },
  });
  const r = await runStopHook({
    agent: "antigravity",
    input: JSON.stringify({ conversationId: "c", workspacePaths: ["/ws"] }),
    connect: fake({ ...poll, tool: "antigravity" }),
    hostPids: () => CHAIN,
  });
  assert.equal(r.decision, "continue");
  assert.match(r.reason, /task_1/);

  // workspacePaths 가 없으면 cwd 인자를 쓴다
  const fake2 = async () => ({
    request: async (type, payload) => {
      const { sessionId: _s, ...rest } = payload;
      assert.deepEqual(rest, {
        tool: "antigravity",
        cwd: "/fallback",
        hostPid: process.ppid,
        hostPids: CHAIN,
      });
      return { ...poll, tool: "antigravity" };
    },
    close() {},
  });
  const r2 = await runStopHook({
    agent: "antigravity",
    input: JSON.stringify({ conversationId: "c" }),
    cwd: "/fallback",
    connect: fake2,
    hostPids: () => CHAIN,
  });
  assert.equal(r2.decision, "continue");
});

test("runStopHook passes the tool's session id so the hub can wake that Codex thread", async () => {
  const seen = [];
  const connect = async () => ({
    request: async (_type, payload) => {
      seen.push(payload);
      return { channelCode: null, incoming: [], results: [], stalled: [] };
    },
    close() {},
  });
  await runStopHook({
    agent: "codex",
    input: JSON.stringify({ cwd: "/repo", session_id: "019a-t" }),
    connect,
  });
  await runStopHook({
    agent: "codex",
    input: JSON.stringify({ cwd: "/repo", session_id: "" }),
    connect,
  });
  await runStopHook({
    agent: "codex",
    input: JSON.stringify({ cwd: "/repo" }),
    connect,
  });
  assert.equal(seen[0].sessionId, "019a-t");
  assert.equal("sessionId" in seen[1], false);
  assert.equal("sessionId" in seen[2], false);
});

test("parentChain follows the ps table upward, stops at pid 1, unknown pids and cycles, and caps at HOST_PID_DEPTH", () => {
  assert.equal(HOST_PID_DEPTH, 6);
  const table = parsePsTable(
    "  500   400\n 400 300\n300 1\n  7 7\nbad line\n 900 800\n800 900\n",
  );
  assert.deepEqual(
    [...table.entries()].sort((a, b) => a[0] - b[0]),
    [
      [7, 7],
      [300, 1],
      [400, 300],
      [500, 400],
      [800, 900],
      [900, 800],
    ],
  );
  assert.deepEqual(parentChain(500, table), [500, 400, 300]); // pid 1 에서 끊는다
  assert.deepEqual(parentChain(400, table), [400, 300]);
  assert.deepEqual(parentChain(12345, table), [12345]); // 표에 없어도 자기 자신은 남는다
  assert.deepEqual(parentChain(900, table), [900, 800]); // 순환
  assert.deepEqual(parentChain(7, table), [7]); // 자기 순환
  assert.deepEqual(parentChain(1, table), []);
  assert.deepEqual(parentChain(0, table), []);
  assert.deepEqual(parentChain(undefined, table), []);
  const deep = new Map();
  for (let i = 20; i > 1; i--) deep.set(i, i - 1);
  assert.deepEqual(parentChain(20, deep), [20, 19, 18, 17, 16, 15]);
  assert.deepEqual(parentChain(20, deep, 2), [20, 19]);
});

test("hostPidChain reads one ps run and falls back to [ppid] on Windows, failure, timeout or an empty table", () => {
  const calls = [];
  const ok = (cmd, args, o) => {
    calls.push([cmd, args, o.timeout]);
    return { status: 0, stdout: " 77 66\n 66 55\n 55 1\n" };
  };
  assert.deepEqual(
    hostPidChain({ ppid: 77, platform: "darwin", exec: ok }),
    [77, 66, 55],
  );
  assert.deepEqual(calls, [["ps", ["-A", "-o", "pid=,ppid="], 1000]]);
  assert.deepEqual(
    hostPidChain({ ppid: 77, platform: "win32", exec: ok }),
    [77],
  );
  assert.deepEqual(
    hostPidChain({
      ppid: 77,
      platform: "linux",
      exec: () => ({ status: 1, stdout: "" }),
    }),
    [77],
  );
  assert.deepEqual(
    hostPidChain({
      ppid: 77,
      platform: "linux",
      exec: () => ({ status: null, stdout: null }),
    }),
    [77],
  );
  assert.deepEqual(
    hostPidChain({
      ppid: 77,
      platform: "linux",
      exec: () => {
        throw new Error("ENOENT");
      },
    }),
    [77],
  );
  // 표가 비었거나 ppid 가 1 이면 [ppid] — 허브가 pid ≤ 1 을 무시한다
  assert.deepEqual(
    hostPidChain({
      ppid: 77,
      platform: "linux",
      exec: () => ({ status: 0, stdout: "" }),
    }),
    [77],
  );
  assert.deepEqual(hostPidChain({ ppid: 1, platform: "linux", exec: ok }), [1]);
  // 실제 ps: 이 프로세스의 부모부터 시작하는 사슬
  if (process.platform !== "win32") {
    const real = hostPidChain();
    assert.equal(real[0], process.ppid);
    // 테스트 프로세스의 부모(테스트 러너)도 부모가 있다 — 1 이면 ps 해석이 조용히 깨진 것이다
    assert.ok(real.length >= 2 && real.length <= HOST_PID_DEPTH, `${real}`);
  }
});

test("runStopHook sends the parent chain from hostPidChain by default", async () => {
  const seen = [];
  const connect = async () => ({
    request: async (_type, payload) => {
      seen.push(payload);
      return { channelCode: null, incoming: [], results: [], stalled: [] };
    },
    close() {},
  });
  await runStopHook({
    agent: "codex",
    input: JSON.stringify({ cwd: "/repo" }),
    connect,
  });
  assert.equal(seen[0].hostPid, process.ppid);
  assert.ok(Array.isArray(seen[0].hostPids));
  assert.equal(seen[0].hostPids[0], process.ppid);
});

test("runStopHook computes the parent chain before it starts connecting (ps never eats the deadline)", async () => {
  const order = [];
  await runStopHook({
    agent: "codex",
    input: JSON.stringify({ cwd: "/repo" }),
    hostPids: () => {
      order.push("hostPids");
      return [process.ppid];
    },
    connect: async () => {
      order.push("connect");
      return {
        request: async (_type, payload) => {
          order.push("request");
          assert.deepEqual(payload.hostPids, [process.ppid]);
          return { channelCode: null, incoming: [], results: [], stalled: [] };
        },
        close() {},
      };
    },
  });
  assert.deepEqual(order, ["hostPids", "connect", "request"]);
});
