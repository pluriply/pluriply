import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStatus,
  formatStatus,
  restartHint,
  shortPath,
  formatWhen,
  summarizeEvents,
} from "../../src/shared/status-format.js";

const HUB = {
  version: "0.8.0",
  fingerprint: "hhhhhhhhhhhh",
  root: "/inst",
  pid: 11495,
  protocol: 11,
  startedAt: "2026-09-28T09:00:00.000Z",
};
const PING = { port: 62085, pid: 11495, version: "0.8.0", protocol: 11 };
function sess(o) {
  return {
    instanceId: "codex#aaaa",
    tool: "codex",
    cwd: "/Users/me/Desktop/1. tqsoft/pluriply-playground",
    worker: false,
    startedAt: "2026-09-28T00:20:00.000Z",
    connectedAt: "2026-09-28T00:20:00.000Z",
    version: "0.8.0",
    fingerprint: "cccccccccccc",
    root: "/inst",
    threadId: null,
    wake: false,
    ...o,
  };
}
/** 루트·부품별 디스크 지문 가짜(호출을 센다) */
function disk(map) {
  const calls = [];
  const fn = (root, part) => {
    calls.push(`${root}|${part}`);
    return map[`${root}|${part}`] ?? null;
  };
  return { fn, calls };
}
const SAME = {
  "/inst|hub": { version: "0.8.0", fingerprint: "hhhhhhhhhhhh" },
  "/inst|connector": { version: "0.8.0", fingerprint: "cccccccccccc" },
};

test("everything up to date", () => {
  const d = disk(SAME);
  const st = buildStatus({
    ping: PING,
    sessions: { hub: HUB, sessions: [sess({})] },
    error: null,
    fingerprint: d.fn,
  });
  assert.equal(st.hub.state, "ok");
  assert.equal(st.sessions[0].state, "ok");
  assert.equal(st.sessions[0].restart, null);
  assert.equal(st.workers, 0);
});

test("older connector code, older connector without fields, unreadable install", () => {
  const d = disk({
    ...SAME,
    "/inst|connector": { version: "0.8.1", fingerprint: "dddddddddddd" },
  });
  const st = buildStatus({
    ping: PING,
    sessions: {
      hub: HUB,
      sessions: [
        sess({ instanceId: "codex#old1" }),
        sess({
          instanceId: "claude-code#x",
          tool: "claude-code",
          version: null,
          fingerprint: null,
          root: null,
        }),
        sess({ instanceId: "codex#gone", root: "/gone" }),
      ],
    },
    error: null,
    fingerprint: d.fn,
  });
  const by = Object.fromEntries(st.sessions.map((s) => [s.instanceId, s]));
  assert.equal(by["codex#old1"].state, "restart");
  assert.deepEqual(by["codex#old1"].onDisk, {
    version: "0.8.1",
    fingerprint: "dddddddddddd",
  });
  assert.equal(by["claude-code#x"].state, "restart");
  assert.equal(by["codex#gone"].state, "unknown");
  assert.equal(by["codex#gone"].restart, null);
});

test("equal versions but different fingerprints show fingerprints in the restart code text", () => {
  const d = disk({
    ...SAME,
    "/inst|connector": { version: "0.8.0", fingerprint: "dddddddddddd" },
  });
  const st = buildStatus({
    ping: PING,
    sessions: { hub: HUB, sessions: [sess({})] },
    error: null,
    fingerprint: d.fn,
  });
  assert.equal(st.sessions[0].state, "restart");
  const text = formatStatus(st, {
    home: "/Users/me",
    now: new Date("2026-09-28T10:00:00"),
  }).join("\n");
  assert.match(
    text,
    /code 0\.8\.0 \(cccccccccccc\) → 0\.8\.0 \(dddddddddddd\) on disk/,
  );
});

test("a new connector with a version but no fingerprint is 'unknown', not 'restart'", () => {
  const d = disk(SAME);
  const st = buildStatus({
    ping: PING,
    sessions: {
      hub: HUB,
      sessions: [
        sess({
          instanceId: "codex#nofp",
          version: "0.8.0",
          fingerprint: null,
        }),
      ],
    },
    error: null,
    fingerprint: d.fn,
  });
  assert.equal(st.sessions[0].state, "unknown");
  const text = formatStatus(st, {
    home: "/Users/me",
    now: new Date("2026-09-28T10:00:00"),
  }).join("\n");
  assert.match(text, /\? codex/);
  assert.match(text, /code 0\.8\.0 \(fingerprint unavailable\)/);
});

test("hub protocol >= 10 but a null fingerprint shows a code line asking for a restart check", () => {
  const st = buildStatus({
    ping: PING,
    sessions: { hub: { ...HUB, fingerprint: null }, sessions: [] },
    error: null,
    fingerprint: disk(SAME).fn,
  });
  assert.equal(st.hub.fingerprint, null);
  const text = formatStatus(st, {
    home: "/Users/me",
    now: new Date("2026-09-28T10:00:00"),
  }).join("\n");
  assert.match(
    text,
    /code 0\.8\.0 \(fingerprint unavailable\)  \? can't read the hub's code/,
  );
});

test("disk fingerprints are computed once per install root and part", () => {
  const d = disk(SAME);
  buildStatus({
    ping: PING,
    sessions: {
      hub: HUB,
      sessions: [
        sess({}),
        sess({ instanceId: "codex#b" }),
        sess({ instanceId: "codex#c" }),
      ],
    },
    error: null,
    fingerprint: d.fn,
  });
  assert.deepEqual(d.calls.sort(), ["/inst|connector", "/inst|hub"]);
});

test("hub on older code", () => {
  const d = disk({
    ...SAME,
    "/inst|hub": { version: "0.8.1", fingerprint: "gggggggggggg" },
  });
  const st = buildStatus({
    ping: PING,
    sessions: { hub: HUB, sessions: [] },
    error: null,
    fingerprint: d.fn,
  });
  assert.equal(st.hub.state, "restart");
  const text = formatStatus(st, {
    home: "/Users/me",
    now: new Date("2026-09-28T10:00:00"),
  }).join("\n");
  assert.match(text, /✗ restart: pluriply hub restart/);
});

test("workers are counted, not listed", () => {
  const st = buildStatus({
    ping: PING,
    sessions: {
      hub: HUB,
      sessions: [sess({}), sess({ instanceId: "codex#w", worker: true })],
    },
    error: null,
    fingerprint: disk(SAME).fn,
  });
  assert.equal(st.workers, 1);
  assert.equal(st.sessions.length, 1);
});

test("restart hints per tool", () => {
  const cwd = "/Users/me/Desktop/1. tqsoft/pluriply-playground"; // sess() 기본 cwd(공백 포함)
  assert.equal(
    restartHint(
      sess({
        tool: "claude-code",
        threadId: "b362375d-65a6-41ff-bd98-7e7e9a93988e",
      }),
    ),
    `/exit, then  cd "${cwd}" && claude --resume b362375d-65a6-41ff-bd98-7e7e9a93988e`,
  );
  assert.equal(
    restartHint(sess({ tool: "claude-code", cwd: "/w" })),
    "/exit and start claude again in /w",
  );
  assert.equal(
    restartHint(sess({ wake: true, threadId: "t1" })),
    `exit, then  cd "${cwd}" && pluriply codex resume t1`,
  );
  assert.equal(
    restartHint(sess({ wake: true, cwd: "/w" })),
    "exit and run pluriply codex in /w",
  );
  assert.equal(
    restartHint(sess({ threadId: "t2" })),
    `exit, then  cd "${cwd}" && codex resume t2`,
  );
  assert.equal(
    restartHint(sess({ cwd: "/w" })),
    "exit and start codex again in /w",
  );
  assert.equal(
    restartHint(sess({ tool: "antigravity" })),
    "quit and reopen Antigravity",
  );
  assert.equal(
    restartHint(sess({ tool: "antigravity-ide" })),
    "quit and reopen Antigravity",
  );
  assert.equal(
    restartHint(sess({ tool: "claude-desktop" })),
    "quit and reopen Claude Desktop",
  );
});

test("restart hint's cd prefix is unquoted for a plain path and omitted when cwd is null", () => {
  assert.equal(
    restartHint(
      sess({ tool: "claude-code", threadId: "id1", cwd: "/Users/me/work" }),
    ),
    "/exit, then  cd /Users/me/work && claude --resume id1",
  );
  assert.equal(
    restartHint(sess({ tool: "claude-code", threadId: "id1", cwd: null })),
    "/exit, then  claude --resume id1",
  );
});

test("short paths and times", () => {
  assert.equal(
    shortPath("/Users/me/Desktop/1. tqsoft/QT/developer", "/Users/me"),
    "~/Desktop/…/developer",
  );
  assert.equal(shortPath("/Users/me/work", "/Users/me"), "~/work");
  assert.equal(shortPath("/opt/x", "/Users/me"), "/opt/x");
  assert.equal(shortPath(null, "/Users/me"), "?");
  const now = new Date(2026, 8, 28, 15, 0);
  assert.equal(
    formatWhen(new Date(2026, 8, 28, 9, 5).toISOString(), now),
    "09:05",
  );
  assert.equal(
    formatWhen(new Date(2026, 8, 18, 10, 2).toISOString(), now),
    "09-18 10:02",
  );
  assert.equal(formatWhen(null, now), "?");
});

test("formatted output keeps the legacy first line, sorts restart first and shows hints", () => {
  const d = disk({
    ...SAME,
    "/inst|connector": { version: "0.8.1", fingerprint: "dddddddddddd" },
  });
  const st = buildStatus({
    ping: PING,
    sessions: {
      hub: HUB,
      sessions: [
        sess({
          instanceId: "codex#new",
          startedAt: "2026-09-28T01:00:00.000Z",
          fingerprint: "dddddddddddd",
          version: "0.8.1",
        }),
        sess({
          instanceId: "claude-code#q",
          tool: "claude-code",
          cwd: "/Users/me/Desktop/1. tqsoft/QT/developer",
          fingerprint: null,
          version: null,
          root: null,
          threadId: "b362375d",
          startedAt: "2026-09-18T01:02:00.000Z",
        }),
      ],
    },
    error: null,
    fingerprint: d.fn,
  });
  const lines = formatStatus(st, {
    home: "/Users/me",
    now: new Date("2026-09-28T10:00:00"),
  });
  assert.match(
    lines[0],
    /running \(port 62085, pid 11495, version 0\.8\.0, protocol 11\)/,
  );
  const text = lines.join("\n");
  assert.match(text, /sessions 2 connected, 1 need a restart/);
  const iOld = text.indexOf("✗ claude-code");
  const iNew = text.indexOf("✓ codex");
  assert.ok(iOld > 0 && iNew > iOld);
  assert.match(text, /unknown \(older connector\)/);
  assert.match(
    text,
    /restart: \/exit, then {2}cd "\/Users\/me\/Desktop\/1\. tqsoft\/QT\/developer" && claude --resume b362375d/,
  );
  assert.match(text, /~\/Desktop\/…\/developer/);
});

test("old hub without hub.sessions and a failed query", () => {
  const old = buildStatus({
    ping: { port: 1, pid: 2, version: "0.7.2", protocol: 9 },
    sessions: null,
    error: null,
  });
  assert.equal(old.sessions, null);
  const oldText = formatStatus(old, {}).join("\n");
  assert.match(
    oldText,
    /running \(port 1, pid 2, version 0\.7\.2, protocol 9\)/,
  );
  assert.match(
    oldText,
    /hub protocol 9 < 11; run `pluriply hub restart` to see sessions/,
  );
  const ten = buildStatus({
    ping: { port: 1, pid: 2, version: "0.8.1", protocol: 10 },
    sessions: null,
    error: null,
  });
  assert.match(formatStatus(ten, {}).join("\n"), /hub protocol 10 < 11/);
  const failed = buildStatus({
    ping: PING,
    sessions: null,
    error: "hub request timed out",
  });
  assert.match(
    formatStatus(failed, {}).join("\n"),
    /sessions unavailable \(hub request timed out\)/,
  );
});

test("json shape", () => {
  const st = buildStatus({
    ping: PING,
    sessions: { hub: HUB, sessions: [sess({})] },
    error: null,
    fingerprint: disk(SAME).fn,
  });
  const round = JSON.parse(JSON.stringify(st));
  assert.deepEqual(Object.keys(round).sort(), [
    "hub",
    "logFile",
    "problems",
    "sessions",
    "sessionsError",
    "workers",
  ]);
  assert.equal(round.hub.running, true);
  assert.deepEqual(Object.keys(round.sessions[0]).includes("restart"), true);
  // Plan 6c §5.2
  for (const k of ["wakeState", "wakeReason", "wakeAt", "fix"])
    assert.ok(k in round.sessions[0], k);
  assert.deepEqual(round.problems, { tasks: [], events: [] });
  assert.equal(round.logFile, null);
  const withLog = buildStatus({
    ping: PING,
    sessions: null,
    error: null,
    logFile: "/Users/me/.pluriply/logs/hub.log",
  });
  assert.equal(withLog.logFile, "/Users/me/.pluriply/logs/hub.log");
  assert.deepEqual(withLog.problems, { tasks: [], events: [] });
});

const NOW = new Date(2026, 8, 30, 10, 0); // 로컬 2026-09-30 10:00
const AT = (h, m) => new Date(2026, 8, 30, h, m).toISOString();

test("wake state: ! with a fix line for failed, · for off, nothing without a report; an old-code mark wins", () => {
  const d = disk({
    ...SAME,
    "/old|connector": { version: "0.9.0", fingerprint: "eeeeeeeeeeee" },
  });
  const st = buildStatus({
    ping: PING,
    sessions: {
      hub: HUB,
      sessions: [
        sess({
          instanceId: "codex#on",
          cwd: "/Users/me/Desktop/1. tqsoft/Pluriply",
          wake: true,
          wakeState: "on",
          wakeAt: AT(9, 15),
        }),
        sess({
          instanceId: "codex#fail",
          cwd: "/Users/me/Desktop/1. tqsoft/flowrika",
          wake: true,
          threadId: "t-f",
          wakeState: "failed",
          wakeReason: "codex queue timed out",
          wakeAt: AT(9, 31),
        }),
        sess({
          instanceId: "codex#off",
          cwd: "/Users/me/Desktop/1. tqsoft/vibebox",
          wakeState: "off",
          wakeReason: "not started with pluriply codex",
          wakeAt: AT(8, 2),
        }),
        sess({
          instanceId: "codex#oldfail",
          cwd: "/old/w",
          root: "/old",
          wake: true,
          threadId: "t-o",
          wakeState: "failed",
          wakeReason: "app server gone",
          wakeAt: AT(9, 40),
        }),
        sess({ instanceId: "claude-code#x", tool: "claude-code", cwd: "/w" }),
      ],
    },
    error: null,
    fingerprint: d.fn,
  });
  const by = Object.fromEntries(st.sessions.map((s) => [s.instanceId, s]));
  assert.equal(
    by["codex#fail"].fix,
    `exit, then  cd "/Users/me/Desktop/1. tqsoft/flowrika" && pluriply codex resume t-f`,
  );
  assert.equal(by["codex#on"].fix, null);
  assert.equal(by["codex#off"].fix, null);
  assert.equal(by["claude-code#x"].wakeState, null);
  assert.equal(by["codex#oldfail"].state, "restart");
  assert.equal(by["codex#oldfail"].fix, null); // 재시작 안내가 우선한다
  // 정렬: 재시작 필요 → 깨우기 실패 → 나머지
  assert.deepEqual(st.sessions.map((s) => s.instanceId).slice(0, 2), [
    "codex#oldfail",
    "codex#fail",
  ]);
  const lines = formatStatus(st, { home: "/Users/me", now: NOW });
  const text = lines.join("\n");
  assert.match(
    text,
    /✗ codex {8}\/old\/w .* wake failed 09:40: app server gone/,
  );
  assert.match(
    text,
    /restart: exit, then {2}cd \/old\/w && pluriply codex resume t-o/,
  );
  assert.match(
    text,
    /! codex {8}~\/Desktop\/1\. tqsoft\/flowrika .* code 0\.8\.0 {3}wake failed 09:31: codex queue timed out\n {6}fix: exit, then {2}cd "\/Users\/me\/Desktop\/1\. tqsoft\/flowrika" && pluriply codex resume t-f/,
  );
  assert.match(
    text,
    /✓ codex {8}~\/Desktop\/1\. tqsoft\/Pluriply .* wake on$/m,
  );
  assert.match(
    text,
    /· codex {8}~\/Desktop\/1\. tqsoft\/vibebox .* wake off \(not started with pluriply codex\)$/m,
  );
  assert.match(text, /✓ claude-code {2}\/w .* code 0\.8\.0$/m); // 보고가 없으면 wake 표시 없음
  assert.ok(!text.includes("problems"));
});

test("problems section lists the last 24h of task and hub events with the log file, and is absent when empty", () => {
  const events = [
    {
      at: AT(9, 30),
      kind: "wake-failed",
      detail: "codex queue timed out",
      by: "codex#fail",
    },
    {
      at: AT(9, 31),
      kind: "to-worker",
      detail:
        "no live session picked it up within 180s; handed to a codex worker (spawned)",
    },
  ];
  const st = buildStatus({
    ping: PING,
    sessions: {
      hub: HUB,
      sessions: [],
      problems: {
        tasks: [
          {
            channelCode: "plp-aaaa-bbbb",
            taskId: "task_8f2c",
            from: "claude-code#s",
            to: "codex",
            request: "리뷰해 줘. 이 파서의 오류 처리를\n특히 자세히 봐 줘",
            status: "completed",
            events,
            at: AT(9, 31),
          },
          {
            channelCode: "plp-aaaa-bbbb",
            taskId: "task_77aa",
            from: "claude-code#s",
            to: "codex#k9cw",
            request: "port the parser",
            status: "submitted",
            events: [
              {
                at: AT(9, 2),
                kind: "unclaimed",
                detail: "no live session picked it up within 180s",
              },
            ],
            at: AT(9, 2),
          },
        ],
        events: [
          {
            at: AT(8, 55),
            kind: "hook-unpaired",
            detail: "Stop hook matched 2 sessions; delivered by folder",
            tool: "claude-code",
            cwd: "/Users/me/Desktop/1. tqsoft/QT/developer",
          },
          {
            at: AT(8, 50),
            kind: "pickup-error",
            detail: "pickup check failed for task_zz: boom",
          },
        ],
      },
    },
    error: null,
    fingerprint: disk(SAME).fn,
    logFile: "/Users/me/.pluriply/logs/hub.log",
  });
  assert.equal(st.problems.tasks.length, 2);
  const lines = formatStatus(st, { home: "/Users/me", now: NOW });
  const i = lines.indexOf("problems (last 24h)");
  assert.ok(i > 0 && lines[i - 1] === "");
  assert.deepEqual(lines.slice(i + 1), [
    '  09:31  task task_8f2c  → codex   wake-failed, then to-worker   "리뷰해 줘. 이 파서의 오류 처리를 특히 자세히 봐 줘"',
    '  09:02  task task_77aa  → codex#k9cw   unclaimed — no live session picked it up within 180s   "port the parser"',
    "  08:55  hook         claude-code ~/Desktop/…/developer   Stop hook matched 2 sessions; delivered by folder",
    "  08:50  hub          pickup check failed for task_zz: boom",
    "  logs: ~/.pluriply/logs/hub.log",
  ]);
  assert.equal(
    summarizeEvents([
      ...events,
      { at: AT(9, 40), kind: "worker-failed", detail: "x".repeat(100) },
    ]),
    `wake-failed, then to-worker, then worker-failed — ${"x".repeat(70)}…`,
  );
  assert.equal(summarizeEvents([]), "");
  assert.equal(
    summarizeEvents([null, 42, { kind: "unclaimed", detail: "x" }]),
    "unclaimed — x",
  );
  // Plan 6d: 무시된 태스크는 `ignored, then to-worker`, 고정 태스크면 `ignored — delivered to …`
  assert.equal(
    summarizeEvents([
      {
        kind: "ignored",
        detail: "delivered to codex#k9cw but its turn ended without a result",
        by: "codex#k9cw",
      },
      { kind: "to-worker", detail: "handed to a codex worker (spawned)" },
    ]),
    "ignored, then to-worker",
  );
  assert.equal(
    summarizeEvents([
      {
        kind: "ignored",
        detail: "delivered to codex#k9cw but its turn ended without a result",
      },
    ]),
    "ignored — delivered to codex#k9cw but its turn ended without a result",
  );
  // 요청은 40자에서 자른다
  const long = buildStatus({
    ping: PING,
    sessions: {
      hub: HUB,
      sessions: [],
      problems: {
        tasks: [
          {
            ...st.problems.tasks[1],
            request: "a".repeat(41),
          },
        ],
        events: [],
      },
    },
    error: null,
    fingerprint: disk(SAME).fn,
  });
  const longText = formatStatus(long, { home: "/Users/me", now: NOW }).join(
    "\n",
  );
  assert.ok(longText.includes(`"${"a".repeat(40)}…"`));
  assert.ok(!longText.includes("logs:")); // logFile 이 없으면 줄이 없다
  // 문제가 없으면 절이 없다
  const clean = formatStatus(
    buildStatus({
      ping: PING,
      sessions: { hub: HUB, sessions: [sess({})] },
      error: null,
      fingerprint: disk(SAME).fn,
      logFile: "/x/hub.log",
    }),
    { home: "/Users/me", now: NOW },
  );
  assert.ok(!clean.some((l) => l.includes("problems") || l.includes("logs:")));
});

test("connector-supplied text is flattened to one line without escape bytes", () => {
  const nasty = "line one\n\x1b[31mred\x1b[0m\rtail\x07";
  const st = buildStatus({
    ping: PING,
    sessions: {
      hub: HUB,
      sessions: [
        sess({
          instanceId: "codex#fail",
          cwd: "/w",
          wake: true,
          wakeState: "failed",
          wakeReason: nasty,
          wakeAt: AT(9, 31),
        }),
        sess({
          instanceId: "codex#off",
          cwd: "/v",
          wakeState: "off",
          wakeReason: nasty,
          wakeAt: AT(9, 30),
        }),
      ],
      problems: {
        tasks: [
          {
            channelCode: "plp-aaaa-bbbb",
            taskId: "task_77aa",
            from: "claude-code#s",
            to: "codex\n\x1b[2Jx",
            request: "port\x1b[31m the parser",
            status: "submitted",
            events: [{ at: AT(9, 2), kind: "wake-failed", detail: nasty }],
            at: AT(9, 2),
          },
        ],
        events: [
          {
            at: AT(8, 55),
            kind: "hook-unpaired",
            detail: nasty,
            tool: "claude-code\n",
            cwd: "/w\n\x1b[1mx",
          },
          { at: AT(8, 50), kind: "pickup-error", detail: nasty },
        ],
      },
    },
    error: null,
    fingerprint: disk(SAME).fn,
  });
  const lines = formatStatus(st, { home: "/Users/me", now: NOW });
  for (const l of lines) {
    assert.ok(
      !/[\x00-\x1f\x7f]/.test(l),
      `control byte in ${JSON.stringify(l)}`,
    );
  }
  const text = lines.join("\n");
  assert.match(text, /wake failed 09:31: line one red tail$/m);
  assert.match(text, /wake off \(line one red tail\)$/m);
  assert.match(
    text,
    /→ codex x {3}wake-failed — line one red tail {3}"port the parser"$/m,
  );
  assert.match(text, /hook {9}claude-code \/w x {3}line one red tail$/m);
  assert.match(text, /hub {10}line one red tail$/m);
});

test("same fingerprint but a different version is ok and says 'same code as' (hub and session)", () => {
  const d = disk({
    "/inst|hub": { version: "0.9.1", fingerprint: "hhhhhhhhhhhh" },
    "/inst|connector": { version: "0.9.1", fingerprint: "cccccccccccc" },
  });
  const st = buildStatus({
    ping: PING,
    sessions: { hub: HUB, sessions: [sess({})] },
    error: null,
    fingerprint: d.fn,
  });
  assert.equal(st.hub.state, "ok");
  assert.equal(st.sessions[0].state, "ok");
  assert.equal(st.sessions[0].restart, null);
  const lines = formatStatus(st, {
    home: "/Users/me",
    now: new Date("2026-09-28T10:00:00"),
  });
  const text = lines.join("\n");
  assert.match(
    text,
    /code 0\.8\.0 \(same code as 0\.9\.1 on disk\)  ✓ up to date/,
  );
  assert.match(text, /✓ codex .*code 0\.8\.0 \(same code as 0\.9\.1 on disk\)/);
});

test("same fingerprint and same version prints the plain version", () => {
  const d = disk(SAME);
  const st = buildStatus({
    ping: PING,
    sessions: { hub: HUB, sessions: [sess({})] },
    error: null,
    fingerprint: d.fn,
  });
  const text = formatStatus(st, { home: "/Users/me" }).join("\n");
  assert.doesNotMatch(text, /same code as/);
  assert.match(text, /code 0\.8\.0 \(hhhhhhhhhhhh\)  on disk/);
});

test("control characters and ANSI in tool, version, cwd never reach the output", () => {
  const d = disk({
    ...SAME,
    "/inst|connector": { version: "0.8.1", fingerprint: "dddddddddddd" },
  });
  const st = buildStatus({
    ping: PING,
    sessions: {
      hub: HUB,
      sessions: [
        sess({
          tool: "co\x1b[31mdex\nx",
          version: "0.8.0\x1b[2J\r\n",
          cwd: "/a/b\x1b[0m\nc d",
        }),
        sess({
          instanceId: "codex#2",
          tool: "claude-code",
          version: "9\x07.9",
          cwd: "/w\nx",
          threadId: null,
        }),
      ],
    },
    error: null,
    fingerprint: d.fn,
  });
  const lines = formatStatus(st, { home: "/Users/me" });
  const text = lines.join("\n");
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f]/);
  for (const l of lines) assert.ok(!l.includes("\r"));
  assert.match(text, /restart: quit and reopen codex x\n/);
  assert.match(text, /restart: \/exit and start claude again in \/w x/);
  const hint = restartHint({
    tool: "we\x1b[1mird\n",
    cwd: "/x\ny",
    threadId: null,
  });
  assert.equal(hint, "quit and reopen weird");
  assert.equal(
    restartHint({ tool: "claude-code", cwd: "/x\x1b[0m\ny", threadId: "t1" }),
    '/exit, then  cd "/x y" && claude --resume t1',
  );
});

test("'same code as' needs both versions; a null process version stays plain", () => {
  const d = disk({
    "/inst|hub": { version: "0.9.1", fingerprint: "hhhhhhhhhhhh" },
    "/inst|connector": { version: "0.9.1", fingerprint: "cccccccccccc" },
  });
  const st = buildStatus({
    ping: { ...PING, version: null },
    sessions: {
      hub: { ...HUB, version: null },
      sessions: [sess({ version: null })],
    },
    error: null,
    fingerprint: d.fn,
  });
  const text = formatStatus(st, { home: "/Users/me" }).join("\n");
  assert.doesNotMatch(text, /same code as/);
  assert.match(text, /✓ codex .*code \?$/m);
});

test("hub running line version is sanitized and a missing tool keeps the old rendering", () => {
  const d = disk(SAME);
  const st = buildStatus({
    ping: { ...PING, version: "0.8.0\x1b[2J\nX" },
    sessions: { hub: { ...HUB, version: "0.8.0\x1b[2J\nX" }, sessions: [] },
    error: null,
    fingerprint: d.fn,
  });
  const lines = formatStatus(st);
  assert.match(lines[0], /version 0\.8\.0 X,/);
  assert.doesNotMatch(lines.join("\n"), /\x1b/);
  assert.equal(restartHint({ cwd: "/x" }), "quit and reopen undefined");
});

test("an ignored task later handed to a worker renders as one problems line", () => {
  const st = buildStatus({
    ping: PING,
    sessions: {
      hub: HUB,
      sessions: [],
      problems: {
        tasks: [
          {
            channelCode: "plp-aaaa-bbbb",
            taskId: "task_1g9d",
            from: "claude-code#s",
            to: "codex",
            request: "port the parser",
            status: "completed",
            events: [
              {
                at: AT(10, 1),
                kind: "ignored",
                detail:
                  "delivered to codex#k9cw but its turn ended without a result",
                by: "codex#k9cw",
              },
              {
                at: AT(10, 2),
                kind: "to-worker",
                detail:
                  "no live session picked it up within 180s; handed to a codex worker (spawned)",
              },
            ],
            at: AT(10, 2),
          },
        ],
        events: [],
      },
    },
    error: null,
    fingerprint: disk(SAME).fn,
    logFile: "/Users/me/.pluriply/logs/hub.log",
  });
  assert.deepEqual(
    st.problems.tasks[0].events.map((e) => e.kind),
    ["ignored", "to-worker"],
  );
  const lines = formatStatus(st, { home: "/Users/me", now: NOW });
  const i = lines.indexOf("problems (last 24h)");
  assert.ok(i > 0);
  assert.deepEqual(lines.slice(i + 1), [
    '  10:02  task task_1g9d  → codex   ignored, then to-worker   "port the parser"',
    "  logs: ~/.pluriply/logs/hub.log",
  ]);
});
