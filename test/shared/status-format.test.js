import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStatus,
  formatStatus,
  restartHint,
  shortPath,
  formatWhen,
} from "../../src/shared/status-format.js";

const HUB = {
  version: "0.8.0",
  fingerprint: "hhhhhhhhhhhh",
  root: "/inst",
  pid: 11495,
  protocol: 10,
  startedAt: "2026-09-28T09:00:00.000Z",
};
const PING = { port: 62085, pid: 11495, version: "0.8.0", protocol: 10 };
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
    /running \(port 62085, pid 11495, version 0\.8\.0, protocol 10\)/,
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
  assert.match(oldText, /run `pluriply hub restart` to see sessions/);
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
    "sessions",
    "sessionsError",
    "workers",
  ]);
  assert.equal(round.hub.running, true);
  assert.deepEqual(Object.keys(round.sessions[0]).includes("restart"), true);
});
