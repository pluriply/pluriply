import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import {
  MCP_REGISTRARS,
  registerMcpServer,
} from "../../src/shared/mcp-register.js";
import { agyCommand } from "../../src/shared/agy.js";
import { seededHome } from "../fixtures/seeded-home.js";

const BIN = "/opt/pluriply/bin/pluriply.js";

/** exec 호출을 기록하고 list 출력만 돌려주는 가짜 execFileSync */
function fakeExec(listOutput, { addThrows = false } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === "list") return Buffer.from(listOutput);
    if (args[1] === "add" && addThrows) throw new Error("boom");
    return Buffer.from("");
  };
  return { exec, calls };
}

test("antigravity registrar adds pluriply with the -- separator when it is missing", () => {
  const { exec, calls } = fakeExec("no servers configured");
  const logs = [];
  const r = registerMcpServer("antigravity", {
    binPath: BIN,
    exec,
    log: (m) => logs.push(m),
    env: {},
    homeDir: seededHome().home,
  });
  assert.equal(r, "registered");
  assert.deepEqual(calls[0], [agyCommand(), "mcp", "list"]);
  assert.deepEqual(calls[1], [
    agyCommand(),
    "mcp",
    "add",
    "pluriply",
    "--",
    process.execPath,
    BIN,
    "connector",
    "--agent",
    "antigravity",
  ]);
  assert.match(logs[0], /registered pluriply MCP server in Antigravity CLI/);
});

test("codex registrar keeps the -- separator and skips when already present", () => {
  const { exec, calls } = fakeExec("pluriply: node …");
  const r = registerMcpServer("codex", {
    binPath: BIN,
    exec,
    log: () => {},
    env: {},
    homeDir: seededHome().home,
  });
  assert.equal(r, "present");
  assert.equal(calls.length, 1);
  const { exec: exec2, calls: calls2 } = fakeExec("");
  registerMcpServer("codex", {
    binPath: BIN,
    exec: exec2,
    log: () => {},
    env: {},
    homeDir: seededHome().home,
  });
  assert.deepEqual(calls2[1], [
    "codex",
    "mcp",
    "add",
    "pluriply",
    "--",
    process.execPath,
    BIN,
    "connector",
    "--agent",
    "codex",
  ]);
});

test("registration failure prints a hint and does not throw", () => {
  const { exec } = fakeExec("", { addThrows: true });
  const logs = [];
  const r = registerMcpServer("antigravity", {
    binPath: BIN,
    exec,
    log: (m) => logs.push(m),
    env: {},
    homeDir: seededHome().home,
  });
  assert.equal(r, "failed");
  assert.match(logs[0], /hint: .*agy mcp add pluriply -- node /);
});

test("skip env vars (new and legacy) and agents without a registrar are no-ops", () => {
  const { exec, calls } = fakeExec("");
  assert.equal(
    registerMcpServer("antigravity", {
      binPath: BIN,
      exec,
      log: () => {},
      env: { PLURIPLY_SKIP_MCP_REGISTER: "1" },
      homeDir: seededHome().home,
    }),
    "skipped",
  );
  assert.equal(
    registerMcpServer("codex", {
      binPath: BIN,
      exec,
      log: () => {},
      env: { PLURIPLY_SKIP_CODEX_MCP: "1" },
      homeDir: seededHome().home,
    }),
    "skipped",
  );
  assert.equal(
    registerMcpServer("claude-code", {
      binPath: BIN,
      exec,
      log: () => {},
      env: {},
      homeDir: seededHome().home,
    }),
    "none",
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(Object.keys(MCP_REGISTRARS).sort(), [
    "antigravity",
    "codex",
  ]);
});

test("registerMcpServer delegates to the setup adapter so worker enable also writes the timeout", () => {
  const { home, codexToml } = seededHome();
  const { exec } = fakeExec("");
  assert.equal(
    registerMcpServer("codex", {
      binPath: BIN,
      exec,
      log: () => {},
      env: {},
      homeDir: home,
    }),
    "registered",
  );
  assert.match(readFileSync(codexToml, "utf8"), /tool_timeout_sec = 600/);
  // 타임아웃을 못 쓰면 계약대로 "failed" 하나로 접는다
  writeFileSync(codexToml, "");
  assert.equal(
    registerMcpServer("codex", {
      binPath: BIN,
      exec,
      log: () => {},
      env: {},
      homeDir: home,
    }),
    "failed",
  );
});
