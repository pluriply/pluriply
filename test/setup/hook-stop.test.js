import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStopReason, runStopHook } from "../../src/setup/hook-stop.js";

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
      assert.deepEqual(payload, { tool: "codex", cwd: "/repo" });
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

test("runStopHook maps workspacePaths[0] for antigravity and answers decision continue", async () => {
  const fake = (reply) => async () => ({
    request: async (type, payload) => {
      assert.equal(type, "hook.poll");
      assert.deepEqual(payload, { tool: "antigravity", cwd: "/ws" });
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
  });
  assert.equal(r.decision, "continue");
  assert.match(r.reason, /task_1/);

  // workspacePaths 가 없으면 cwd 인자를 쓴다
  const fake2 = async () => ({
    request: async (type, payload) => {
      assert.deepEqual(payload, { tool: "antigravity", cwd: "/fallback" });
      return { ...poll, tool: "antigravity" };
    },
    close() {},
  });
  const r2 = await runStopHook({
    agent: "antigravity",
    input: JSON.stringify({ conversationId: "c" }),
    cwd: "/fallback",
    connect: fake2,
  });
  assert.equal(r2.decision, "continue");
});
