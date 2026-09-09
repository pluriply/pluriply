import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENTS, makeEnv, configPath } from "../../src/setup/clients.js";

const BIN = "/opt/pluriply/bin/pluriply.js";
const byId = (id) => CLIENTS.find((c) => c.id === id);

function fakeExec({ version = true, list = "", addThrows = false } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "--version") {
      if (!version) throw new Error("ENOENT");
      return Buffer.from("1.2.3\n");
    }
    if (args[1] === "list") return Buffer.from(list);
    if (args[1] === "add" && addThrows) throw new Error("boom");
    return Buffer.from("");
  };
  return { exec, calls };
}
const env = (o) => makeEnv({ binPath: BIN, log: () => {}, processEnv: {}, node: "/usr/bin/node", ...o });

test("CLI adapters detect via --version, read status from mcp list, and register with the right argv", () => {
  const { exec, calls } = fakeExec({ list: "nothing" });
  const cc = byId("claude-code");
  assert.deepEqual(cc.detect(env({ exec })), { installed: true, detail: "1.2.3" });
  assert.equal(cc.status(env({ exec })), "missing");
  assert.equal(cc.register(env({ exec })), "registered");
  assert.deepEqual(calls.at(-1), ["claude", "mcp", "add", "-s", "user", "pluriply", "--", "/usr/bin/node", BIN, "connector", "--agent", "claude-code"]);
  assert.equal(byId("codex").register(env({ exec })), "registered");
  assert.deepEqual(calls.at(-1).slice(0, 5), ["codex", "mcp", "add", "pluriply", "--"]);
  assert.equal(byId("antigravity").register(env({ exec })), "registered");
  assert.deepEqual(calls.at(-1).slice(1, 6), ["mcp", "add", "pluriply", "--", "/usr/bin/node"]);
  assert.equal(calls.at(-1).at(-1), "antigravity");
  // 이미 등록 / 미설치 / add 실패 / 스킵
  const present = fakeExec({ list: "pluriply: node …" });
  assert.equal(cc.register(env({ exec: present.exec })), "present");
  assert.deepEqual(cc.detect(env({ exec: fakeExec({ version: false }).exec })), { installed: false });
  const logs = [];
  assert.equal(cc.register(env({ exec: fakeExec({ addThrows: true }).exec, log: (m) => logs.push(m) })), "failed");
  assert.match(logs[0], /hint: .*claude mcp add -s user pluriply -- node/);
  assert.equal(cc.register(env({ exec, processEnv: { PLURIPLY_SKIP_MCP_REGISTER: "1" } })), "skipped");
  assert.equal(byId("codex").register(env({ exec, processEnv: { PLURIPLY_SKIP_CODEX_MCP: "1" } })), "skipped");
});

test("configPath follows the OS conventions", () => {
  assert.equal(configPath("claude-desktop", { homeDir: "/h", platform: "darwin" }), "/h/Library/Application Support/Claude/claude_desktop_config.json");
  assert.equal(configPath("claude-desktop", { homeDir: "/h", platform: "linux" }), "/h/.config/Claude/claude_desktop_config.json");
  assert.match(configPath("claude-desktop", { homeDir: "C:\\u", platform: "win32", processEnv: { APPDATA: "C:\\u\\AppData\\Roaming" } }), /AppData.*Roaming.*Claude.*claude_desktop_config\.json$/);
  assert.equal(configPath("antigravity-ide", { homeDir: "/h", platform: "linux" }), "/h/.gemini/antigravity/mcp_config.json");
  // Antigravity 가 IDE(antigravity-ide) 와 허브(antigravity) 로 갈라진 뒤에는 IDE 데이터 폴더가 우선
  const ideFs = { existsSync: (p) => p === "/h/.gemini/antigravity-ide" };
  assert.equal(configPath("antigravity-ide", { homeDir: "/h", platform: "linux", fs: ideFs }), "/h/.gemini/antigravity-ide/mcp_config.json");
  const noIdeFs = { existsSync: () => false };
  assert.equal(configPath("antigravity-ide", { homeDir: "/h", platform: "linux", fs: noIdeFs }), "/h/.gemini/antigravity/mcp_config.json");
});

test("JSON adapters back up, write atomically, preserve other servers, stay idempotent, and refuse corrupt files", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-home-"));
  const cd = byId("claude-desktop");
  assert.deepEqual(cd.detect(env({ homeDir: home, platform: "linux" })), { installed: false });
  const file = configPath("claude-desktop", { homeDir: home, platform: "linux" });
  mkdirSync(join(home, ".config", "Claude"), { recursive: true });
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
  const e = env({ homeDir: home, platform: "linux" });
  assert.equal(cd.detect(e).installed, true);
  assert.equal(cd.status(e), "missing");
  assert.equal(cd.register(e), "registered");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc.mcpServers.pluriply, { command: "/usr/bin/node", args: [BIN, "connector", "--agent", "claude-desktop"] });
  assert.equal(doc.mcpServers.other.command, "x");
  assert.equal(doc.theme, "dark");
  assert.ok(existsSync(`${file}.bak`));
  assert.equal(cd.status(e), "present");
  assert.equal(cd.register(e), "present");
  assert.equal(cd.register(env({ homeDir: home, platform: "linux", processEnv: { PLURIPLY_SKIP_MCP_REGISTER: "1" } })), "skipped");

  // 빈 파일은 초기화, 손상 파일은 거부
  const ide = byId("antigravity-ide");
  const ideFile = configPath("antigravity-ide", { homeDir: home });
  mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
  writeFileSync(ideFile, "");
  assert.equal(ide.register(e), "registered");
  assert.equal(JSON.parse(readFileSync(ideFile, "utf8")).mcpServers.pluriply.args.at(-1), "antigravity-ide");
  writeFileSync(ideFile, "{not json");
  const logs = [];
  assert.deepEqual(typeof ide.status(e), "object");
  assert.equal(ide.register(env({ homeDir: home, platform: "linux", log: (m) => logs.push(m) })), "failed");
  assert.equal(readFileSync(ideFile, "utf8"), "{not json");
  assert.match(logs[0], /cannot update Antigravity IDE config/);
});
