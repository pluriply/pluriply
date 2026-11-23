import { test } from "node:test";
import assert from "node:assert/strict";
import {
  redactResult,
  viewTask,
  viewChannel,
  buildSnapshot,
  LOG_TAIL_MARKER,
  ACTIVE_WINDOW_MS,
  STALE_OPEN_MS,
  PREVIEW_CHARS,
  isActiveAt,
} from "../../src/view/model.js";

const T = Date.parse("2026-11-01T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

test("redactResult hides the worker log tail", () => {
  assert.equal(
    redactResult(
      `worker exited without submitting a result (exit 1)${LOG_TAIL_MARKER}\nexec: cat secret.txt`,
    ),
    "worker exited without submitting a result (exit 1)\n(worker log hidden)",
  );
  assert.deepEqual(redactResult({ a: 1 }), { a: 1 });
  assert.equal(redactResult(null), null);
  assert.equal(redactResult("plain result"), "plain result");
});

test("viewTask keeps only allowlisted fields", () => {
  const v = viewTask({
    taskId: "task_1",
    from: "claude-code#aaaa",
    to: "codex",
    status: "completed",
    request: "do it",
    cwd: "/secret/cwd",
    fromCwdKey: "k",
    hookDelivered: true,
    dispatch: "worker",
    worker: { log: "/x/task.log" },
    events: [{ at: "t", kind: "created", detail: "d", by: "x", secret: "s" }],
  });
  for (const k of ["cwd", "fromCwdKey", "hookDelivered", "dispatch", "worker"])
    assert.equal(k in v, false, k);
  assert.equal(JSON.stringify(v).includes("/x/task.log"), false);
  assert.equal("secret" in v.events[0], false);
  assert.equal(v.events[0].by, "x");
  assert.equal("toInstance" in v, false);
  assert.equal(v.open, false);
});

test("task line preview is capped", () => {
  const v = viewTask({
    taskId: "t",
    status: "submitted",
    request: "a".repeat(5000),
  });
  assert.equal(v.preview.length, PREVIEW_CHARS + 1);
  assert.ok(v.preview.endsWith("…"));
  assert.equal(v.request.length, 5000);
  assert.equal(v.open, true);
  assert.equal(
    viewTask({ taskId: "t", request: "a   b\n c" }).preview,
    "a b c",
  );
});

test("viewChannel computes activity", () => {
  const doc = {
    channel: { code: "plp-aaaa-bbbb", createdAt: iso(T - 5000), peers: [] },
    tasks: [
      {
        taskId: "t1",
        status: "completed",
        createdAt: iso(T - 100),
        updatedAt: iso(T),
      },
    ],
    context: [
      { entryId: "e1", from: "codex", summary: "s", at: iso(T + 1000) },
    ],
  };
  const c = viewChannel(doc, { now: T + 1000 + ACTIVE_WINDOW_MS });
  assert.equal(c.lastActivityAt, iso(T + 1000));
  assert.equal(c.active, false);
  assert.equal(
    viewChannel(doc, { now: T + 1000 + ACTIVE_WINDOW_MS - 1 }).active,
    true,
  );
  doc.tasks.push({
    taskId: "t2",
    status: "submitted",
    createdAt: iso(T - 50),
    updatedAt: iso(T - 50),
  });
  const o = viewChannel(doc, { now: T + 10 * ACTIVE_WINDOW_MS });
  assert.equal(o.active, true);
  assert.equal(o.openTaskCount, 1);
});

test("viewChannel fills participants from tasks", () => {
  const doc = {
    channel: { code: "plp-aaaa-bbbb", createdAt: iso(T), peers: [] },
    tasks: [
      {
        taskId: "t1",
        from: "claude-code#ab12",
        to: "codex",
        completedBy: "codex worker",
        status: "completed",
        createdAt: iso(T),
        updatedAt: iso(T),
      },
    ],
  };
  const c = viewChannel(doc, { now: T });
  assert.deepEqual(c.participants.map((p) => p.id).sort(), [
    "claude-code#ab12",
    "codex",
    "codex worker",
  ]);
  assert.deepEqual(
    c.participants.filter((p) => p.worker).map((p) => p.id),
    ["codex worker"],
  );
  assert.equal(
    c.participants.find((p) => p.id === "codex worker").tool,
    "codex",
  );
  assert.equal(
    c.participants.find((p) => p.id === "claude-code#ab12").tool,
    "claude-code",
  );
  const on = viewChannel(doc, {
    now: T,
    online: new Set(["claude-code#ab12"]),
  });
  assert.deepEqual(
    on.participants.filter((p) => p.online).map((p) => p.id),
    ["claude-code#ab12"],
  );
});

test("viewChannel tolerates legacy and partial docs", () => {
  const c = viewChannel(
    {
      channel: {
        code: "plp-aaaa-bbbb",
        createdAt: iso(T),
        peers: [{ agent: "claude-code", joinedAt: iso(T) }],
      },
    },
    { now: T },
  );
  assert.deepEqual(c.tasks, []);
  assert.deepEqual(
    c.participants.map((p) => p.id),
    ["claude-code"],
  );
  assert.equal(c.lastActivityAt, iso(T));
  assert.doesNotThrow(() => viewChannel({}, { now: T }));
});

test("buildSnapshot orders channels and reports hub state", () => {
  const mk = (code, at, peers = []) => ({
    channel: { code, createdAt: iso(at), peers },
    tasks: [
      {
        taskId: code,
        status: "completed",
        createdAt: iso(at),
        updatedAt: iso(at),
      },
    ],
  });
  const now = T + 10 * ACTIVE_WINDOW_MS;
  const snap = buildSnapshot({
    channels: [
      mk("plp-old1-aaaa", T),
      mk("plp-live-aaaa", now - 1000, [
        { instanceId: "codex#k2ck", tool: "codex" },
      ]),
      mk("plp-mid1-aaaa", T + 1000),
    ],
    sessions: {
      sessions: [
        {
          instanceId: "codex#k2ck",
          tool: "codex",
          cwd: "/p",
          worker: false,
          connectedAt: iso(T),
          fingerprint: "x",
        },
      ],
    },
    now,
  });
  assert.deepEqual(
    snap.channels.map((c) => c.code),
    ["plp-live-aaaa", "plp-mid1-aaaa", "plp-old1-aaaa"],
  );
  assert.equal(snap.hub.running, true);
  assert.equal(snap.hub.sessionCount, 1);
  assert.equal("fingerprint" in snap.sessions[0], false);
  assert.equal(
    snap.channels[0].participants.find((p) => p.id === "codex#k2ck").online,
    true,
  );
  const off = buildSnapshot({ channels: [], sessions: null, now });
  assert.equal(off.hub.running, false);
  assert.deepEqual(off.sessions, []);
  assert.equal(off.generatedAt, iso(now));
});

test("stale open tasks do not keep a channel active", () => {
  const mk = (ageMs) => ({
    channel: { code: "plp-aaaa-bbbb", createdAt: iso(T - 90 * 86_400_000) },
    tasks: [
      {
        taskId: "t",
        status: "submitted",
        createdAt: iso(T - ageMs),
        updatedAt: iso(T - ageMs),
      },
    ],
  });
  const old = viewChannel(mk(25 * 3_600_000), { now: T });
  assert.equal(old.active, false);
  assert.equal(old.openTaskCount, 1);
  assert.equal(old.freshOpenTaskCount, 0);
  const fresh = viewChannel(mk(3_600_000), { now: T });
  assert.equal(fresh.active, true);
  assert.equal(fresh.freshOpenTaskCount, 1);
});

test("activeUntil and isActiveAt carry the one activity rule", () => {
  const doc = {
    channel: { code: "plp-aaaa-bbbb", createdAt: iso(T - 90 * 86_400_000) },
    tasks: [
      {
        taskId: "done",
        status: "completed",
        createdAt: iso(T - 2000),
        updatedAt: iso(T),
      },
    ],
  };
  const v = viewChannel(doc, { now: T });
  assert.equal(v.activeUntil, T + ACTIVE_WINDOW_MS);
  assert.equal(isActiveAt(v, T + ACTIVE_WINDOW_MS - 1), true);
  assert.equal(isActiveAt(v, T + ACTIVE_WINDOW_MS), false);
  // 열린 태스크는 만든 뒤 STALE_OPEN_MS 까지 활동 중으로 둔다
  doc.tasks.push({
    taskId: "open",
    status: "working",
    createdAt: iso(T - 1000),
    updatedAt: iso(T - 1000),
  });
  const o = viewChannel(doc, { now: T });
  assert.equal(o.activeUntil, T - 1000 + STALE_OPEN_MS);
  assert.equal(isActiveAt(o, T - 1001 + STALE_OPEN_MS), true);
  assert.equal(isActiveAt(o, T - 1000 + STALE_OPEN_MS), false);
  // active 는 같은 판정의 지금 값
  for (const now of [T, T + ACTIVE_WINDOW_MS, T + STALE_OPEN_MS])
    assert.equal(
      viewChannel(doc, { now }).active,
      isActiveAt(viewChannel(doc, { now }), now),
    );
  assert.equal(isActiveAt({}, T), false);
});

test("buildSnapshot skips session entries that are not objects", () => {
  const snap = buildSnapshot({
    channels: [],
    sessions: {
      sessions: [null, 7, "x", { instanceId: "codex#k2ck", tool: "codex" }],
    },
    now: T,
  });
  assert.deepEqual(
    snap.sessions.map((s) => s.instanceId),
    ["codex#k2ck"],
  );
  assert.equal(snap.hub.sessionCount, 1);
});
