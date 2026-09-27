import { test } from "node:test";
import assert from "node:assert/strict";
import { formatActivity } from "../../src/shared/activity-format.js";
import { formatStopReason } from "../../src/setup/hook-stop.js";

const base = {
  tool: "claude-code",
  cwd: "/repo",
  channelCode: "plp-ab12-cd34",
  incoming: [
    { taskId: "task_1", kind: "task", from: "codex#9f3e", summary: "Do it" },
  ],
  results: [
    {
      taskId: "task_2",
      status: "completed",
      to: "codex#9f3e",
      summary: "Done",
    },
  ],
  more: 0,
};

test("formatStopReason is formatActivity (the hook keeps its old name)", () => {
  assert.equal(formatStopReason, formatActivity);
});

test("formatActivity renders a stalled section with the hint", () => {
  const text = formatActivity({
    ...base,
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
  });
  assert.match(text, /^pluriply: new activity on channel plp-ab12-cd34/);
  assert.match(
    text,
    /Waiting on others \(no live session picked these up; see the hint\):\n- task_9 to codex: "Port the parser" — no live session picked it up within 120s; worker disabled/,
  );
  assert.doesNotMatch(text, /Incoming tasks/);
  assert.doesNotMatch(text, /Results of tasks/);
});

test("formatActivity without stalled items is unchanged from the old hook text", () => {
  const text = formatActivity(base);
  assert.equal(
    text,
    [
      "pluriply: new activity on channel plp-ab12-cd34 for claude-code (cwd /repo). Handle it before finishing.",
      "Incoming tasks (do the work, then submit_result — or submit_review for reviews; skip one another instance already claimed):",
      '- task_1 task from codex#9f3e: "Do it"',
      "Results of tasks you delegated (read them with get_task_result):",
      '- task_2 completed by codex#9f3e: "Done"',
    ].join("\n"),
  );
});

test("formatActivity trims stalled lines first when over 2,000 characters", () => {
  const stalled = Array.from({ length: 30 }, (_, i) => ({
    taskId: `task_s${i}`,
    to: "codex",
    summary: "y".repeat(80),
    hint: "h".repeat(40),
  }));
  const text = formatActivity({ ...base, stalled });
  assert.ok(text.length <= 2000, `length ${text.length}`);
  assert.match(text, /- task_1 task from/); // 받은 태스크는 남는다
  assert.match(text, /\(\+\d+ more: run list_tasks\)/);
});
