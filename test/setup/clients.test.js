import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  lstatSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENTS,
  makeEnv,
  configPath,
  codexConfigPath,
  agyConfigPath,
  TOOL_TIMEOUT_SEC,
} from "../../src/setup/clients.js";
import { emptyHome, seededHome } from "../fixtures/seeded-home.js";
import { skipOnWindows, skipUnlessSymlinks } from "../fixtures/platform.js";

const BIN = "/opt/pluriply/bin/pluriply.js";
const byId = (id) => CLIENTS.find((c) => c.id === id);

/** ~/.claude.json 을 미리 둔 임시 홈. claude-code 의 스코프 인식 status 테스트용. */
function claudeJsonHome(doc) {
  const home = emptyHome();
  writeFileSync(join(home, ".claude.json"), JSON.stringify(doc));
  return home;
}

/** ~/.claude.json 이 손상된(JSON 파싱 실패) 홈 — status 가 `mcp list` 로 폴백해야 한다. */
function corruptClaudeHome() {
  const home = emptyHome();
  writeFileSync(join(home, ".claude.json"), "{not json");
  return home;
}

function fakeExec({
  version = true,
  list = "",
  addThrows = false,
  removeThrows = false,
} = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "--version") {
      if (!version) throw new Error("ENOENT");
      return Buffer.from("1.2.3\n");
    }
    if (args[1] === "list") return Buffer.from(list);
    if (args[1] === "add" && addThrows) throw new Error("boom");
    if (args[1] === "remove" && removeThrows) throw new Error("boom");
    return Buffer.from("");
  };
  return { exec, calls };
}
/** 기본 homeDir 는 빈 임시 홈: 어떤 테스트도 진짜 ~/.codex, ~/.gemini 를 건드리지 않는다 */
const env = (o) =>
  makeEnv({
    binPath: BIN,
    log: () => {},
    processEnv: {},
    node: "/usr/bin/node",
    homeDir: emptyHome(),
    ...o,
  });

test("CLI adapters detect via --version, read status from mcp list, and register with the right argv", () => {
  const { exec, calls } = fakeExec({ list: "nothing" });
  const cc = byId("claude-code");
  assert.deepEqual(cc.detect(env({ exec })), {
    installed: true,
    detail: "1.2.3",
  });
  assert.equal(cc.status(env({ exec })), "missing");
  assert.equal(cc.register(env({ exec })), "registered");
  assert.deepEqual(calls.at(-1), [
    "claude",
    "mcp",
    "add",
    "-s",
    "user",
    "pluriply",
    "--",
    "/usr/bin/node",
    BIN,
    "connector",
    "--agent",
    "claude-code",
  ]);
  const seeded = seededHome().home;
  assert.equal(
    byId("codex").register(env({ exec, homeDir: seeded })),
    "registered",
  );
  assert.deepEqual(calls.at(-1).slice(0, 5), [
    "codex",
    "mcp",
    "add",
    "pluriply",
    "--",
  ]);
  assert.equal(
    byId("antigravity").register(env({ exec, homeDir: seeded })),
    "registered",
  );
  assert.deepEqual(calls.at(-1).slice(1, 6), [
    "mcp",
    "add",
    "pluriply",
    "--",
    "/usr/bin/node",
  ]);
  assert.equal(calls.at(-1).at(-1), "antigravity");
  // 이미 등록 / 미설치 / add 실패 / 스킵
  // claude-code 는 status 가 ~/.claude.json 을 먼저 보므로(스코프 인식 override) 여기서 "present"
  // 이려면 그 파일에 user-scope 등록이 있어야 한다 — `mcp list` 출력만으로는 판정하지 않는다.
  const present = fakeExec({ list: "pluriply: node …" });
  const presentHome = claudeJsonHome({ mcpServers: { pluriply: {} } });
  assert.equal(
    cc.register(env({ exec: present.exec, homeDir: presentHome })),
    "present",
  );
  assert.deepEqual(
    cc.detect(env({ exec: fakeExec({ version: false }).exec })),
    { installed: false },
  );
  const logs = [];
  assert.equal(
    cc.register(
      env({
        exec: fakeExec({ addThrows: true }).exec,
        log: (m) => logs.push(m),
      }),
    ),
    "failed",
  );
  assert.match(logs[0], /hint: .*claude mcp add -s user pluriply -- node/);
  assert.equal(
    cc.register(env({ exec, processEnv: { PLURIPLY_SKIP_MCP_REGISTER: "1" } })),
    "skipped",
  );
  assert.equal(
    byId("codex").register(
      env({ exec, processEnv: { PLURIPLY_SKIP_CODEX_MCP: "1" } }),
    ),
    "skipped",
  );
});

test("claude-code status reads ~/.claude.json for the user scope instead of the scope-merged `mcp list`", () => {
  const cc = byId("claude-code");

  // project-local 항목이 있어도(다른 프로젝트에 등록됨) user-scope 가 비어 있으면 missing —
  // `mcp list` 출력에 pluriply 가 보여도(스코프를 합쳐 보여주므로) 그걸로 판정하지 않는다.
  const shadowedHome = claudeJsonHome({
    mcpServers: { other: {} },
    projects: { "/p": { mcpServers: { pluriply: {} } } },
  });
  assert.equal(
    cc.status(
      env({
        exec: fakeExec({ list: "pluriply: node …" }).exec,
        homeDir: shadowedHome,
      }),
    ),
    "missing",
  );
  const registerCalls = fakeExec({ list: "pluriply: node …" });
  assert.equal(
    cc.register(env({ exec: registerCalls.exec, homeDir: shadowedHome })),
    "registered",
  );
  assert.deepEqual(registerCalls.calls.at(-1), [
    "claude",
    "mcp",
    "add",
    "-s",
    "user",
    "pluriply",
    "--",
    "/usr/bin/node",
    BIN,
    "connector",
    "--agent",
    "claude-code",
  ]);
  assert.equal(
    cc.unregister(
      env({
        exec: fakeExec({ list: "pluriply: node …" }).exec,
        homeDir: shadowedHome,
      }),
    ),
    "absent",
  );

  // 최상위 mcpServers.pluriply 가 있으면 present — `mcp list` 가 아무것도 안 보여줘도 상관없다.
  const presentHome = claudeJsonHome({ mcpServers: { pluriply: {} } });
  assert.equal(
    cc.status(
      env({ exec: fakeExec({ list: "nothing" }).exec, homeDir: presentHome }),
    ),
    "present",
  );
  assert.equal(
    cc.register(
      env({ exec: fakeExec({ list: "nothing" }).exec, homeDir: presentHome }),
    ),
    "present",
  );
  const removeCalls = fakeExec({ list: "nothing" });
  assert.equal(
    cc.unregister(env({ exec: removeCalls.exec, homeDir: presentHome })),
    "removed",
  );
  assert.deepEqual(removeCalls.calls.at(-1), [
    "claude",
    "mcp",
    "remove",
    "-s",
    "user",
    "pluriply",
  ]);

  // ~/.claude.json 이 아예 없으면(첫 실행 전) missing
  assert.equal(
    cc.status(env({ exec: fakeExec({ list: "pluriply" }).exec })),
    "missing",
  );

  // 손상된(파싱 실패) 파일이면 기존 `mcp list` 판정으로 폴백한다
  const corruptHome = corruptClaudeHome();
  assert.equal(
    cc.status(
      env({
        exec: fakeExec({ list: "pluriply: node …" }).exec,
        homeDir: corruptHome,
      }),
    ),
    "present",
  );
  assert.equal(
    cc.status(
      env({ exec: fakeExec({ list: "nothing" }).exec, homeDir: corruptHome }),
    ),
    "missing",
  );
});

test("configPath follows the OS conventions", () => {
  assert.equal(
    configPath("claude-desktop", { homeDir: "/h", platform: "darwin" }),
    join(
      "/h",
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    ),
  );
  assert.equal(
    configPath("claude-desktop", { homeDir: "/h", platform: "linux" }),
    join("/h", ".config", "Claude", "claude_desktop_config.json"),
  );
  assert.match(
    configPath("claude-desktop", {
      homeDir: "C:\\u",
      platform: "win32",
      processEnv: { APPDATA: "C:\\u\\AppData\\Roaming" },
    }),
    /AppData.*Roaming.*Claude.*claude_desktop_config\.json$/,
  );
  assert.equal(
    configPath("antigravity-ide", { homeDir: "/h", platform: "linux" }),
    join("/h", ".gemini", "antigravity", "mcp_config.json"),
  );
  // Antigravity 가 IDE(antigravity-ide) 와 허브(antigravity) 로 갈라진 뒤에는 IDE 데이터 폴더가 우선
  const ideFs = {
    existsSync: (p) => p === join("/h", ".gemini", "antigravity-ide"),
  };
  assert.equal(
    configPath("antigravity-ide", {
      homeDir: "/h",
      platform: "linux",
      fs: ideFs,
    }),
    join("/h", ".gemini", "antigravity-ide", "mcp_config.json"),
  );
  const noIdeFs = { existsSync: () => false };
  assert.equal(
    configPath("antigravity-ide", {
      homeDir: "/h",
      platform: "linux",
      fs: noIdeFs,
    }),
    join("/h", ".gemini", "antigravity", "mcp_config.json"),
  );
});

test("JSON adapters back up, write atomically, preserve other servers, stay idempotent, and refuse corrupt files", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-home-"));
  const cd = byId("claude-desktop");
  assert.deepEqual(cd.detect(env({ homeDir: home, platform: "linux" })), {
    installed: false,
  });
  const file = configPath("claude-desktop", {
    homeDir: home,
    platform: "linux",
  });
  mkdirSync(join(home, ".config", "Claude"), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }),
  );
  const e = env({ homeDir: home, platform: "linux" });
  assert.equal(cd.detect(e).installed, true);
  assert.equal(cd.status(e), "missing");
  assert.equal(cd.register(e), "registered");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc.mcpServers.pluriply, {
    command: "/usr/bin/node",
    args: [BIN, "connector", "--agent", "claude-desktop"],
  });
  assert.equal(doc.mcpServers.other.command, "x");
  assert.equal(doc.theme, "dark");
  assert.ok(existsSync(`${file}.bak`));
  assert.equal(cd.status(e), "present");
  assert.equal(cd.register(e), "present");
  assert.equal(
    cd.register(
      env({
        homeDir: home,
        platform: "linux",
        processEnv: { PLURIPLY_SKIP_MCP_REGISTER: "1" },
      }),
    ),
    "skipped",
  );

  // 빈 파일은 초기화, 손상 파일은 거부
  const ide = byId("antigravity-ide");
  const ideFile = configPath("antigravity-ide", { homeDir: home });
  mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
  writeFileSync(ideFile, "");
  assert.equal(ide.register(e), "registered");
  assert.equal(
    JSON.parse(readFileSync(ideFile, "utf8")).mcpServers.pluriply.args.at(-1),
    "antigravity-ide",
  );
  writeFileSync(ideFile, "{not json");
  const logs = [];
  assert.deepEqual(typeof ide.status(e), "object");
  assert.equal(
    ide.register(
      env({ homeDir: home, platform: "linux", log: (m) => logs.push(m) }),
    ),
    "failed",
  );
  assert.equal(readFileSync(ideFile, "utf8"), "{not json");
  assert.match(logs[0], /cannot update Antigravity IDE config/);
});

test("CLI adapters unregister with mcp remove and report absent/failed/skipped", () => {
  const { exec, calls } = fakeExec({ list: "pluriply: node …" });
  const cc = byId("claude-code");
  // claude-code 의 status 는 ~/.claude.json 을 먼저 본다 — "removed" 로 가려면 user-scope 등록이
  // 그 파일에 있어야 한다(스코프 인식 status 는 아래 전용 테스트에서 자세히 다룬다).
  assert.equal(
    cc.unregister(
      env({ exec, homeDir: claudeJsonHome({ mcpServers: { pluriply: {} } }) }),
    ),
    "removed",
  );
  assert.deepEqual(calls.at(-1), [
    "claude",
    "mcp",
    "remove",
    "-s",
    "user",
    "pluriply",
  ]);
  assert.equal(byId("codex").unregister(env({ exec })), "removed");
  assert.deepEqual(calls.at(-1), ["codex", "mcp", "remove", "pluriply"]);
  assert.equal(byId("antigravity").unregister(env({ exec })), "removed");
  assert.deepEqual(calls.at(-1).slice(1), ["mcp", "remove", "pluriply"]);
  assert.equal(
    cc.unregister(env({ exec: fakeExec({ list: "nothing" }).exec })),
    "absent",
  );
  const logs = [];
  assert.equal(
    cc.unregister(
      env({
        exec: fakeExec({ list: "pluriply", removeThrows: true }).exec,
        log: (m) => logs.push(m),
        homeDir: claudeJsonHome({ mcpServers: { pluriply: {} } }),
      }),
    ),
    "failed",
  );
  assert.match(logs[0], /hint: .*claude mcp remove -s user pluriply/);
  const listFails = (cmd, args) => {
    if (args[0] === "--version") return Buffer.from("1\n");
    throw new Error("list broke");
  };
  // ~/.claude.json 이 손상돼 override 가 폴백하는 경우에만 `mcp list` 실패가 status 의 object
  // 에러로 이어진다 — 파일이 아예 없으면 override 가 "missing" 을 바로 돌려줘 list 를 안 부른다.
  assert.equal(
    cc.unregister(env({ exec: listFails, homeDir: corruptClaudeHome() })),
    "failed",
  );
  assert.equal(
    cc.unregister(
      env({ exec, processEnv: { PLURIPLY_SKIP_MCP_REGISTER: "1" } }),
    ),
    "skipped",
  );
});

test("codex unregister sweeps leftover [mcp_servers.pluriply*] sections from config.toml", () => {
  const { home, codexToml } = seededHome();
  writeFileSync(
    codexToml,
    'model = "gpt"\n\n[mcp_servers.pluriply.tools.join_channel]\napproval_mode = "approve"\n\n[mcp_servers.other]\ncommand = "x"\n',
  );
  const { exec } = fakeExec({ list: "pluriply" });
  assert.equal(
    byId("codex").unregister(env({ exec, homeDir: home })),
    "removed",
  );
  const text = readFileSync(codexToml, "utf8");
  assert.doesNotMatch(text, /pluriply/);
  assert.match(text, /\[mcp_servers\.other\]\ncommand = "x"/);
  assert.ok(existsSync(`${codexToml}.bak`));
  // 남은 게 없으면 파일을 다시 쓰지 않는다(백업도 갱신하지 않는다)
  writeFileSync(`${codexToml}.bak`, "marker");
  assert.equal(
    byId("codex").unregister(env({ exec, homeDir: home })),
    "removed",
  );
  assert.equal(readFileSync(`${codexToml}.bak`, "utf8"), "marker");
  // 설정 파일이 없어도 removed
  assert.equal(
    byId("codex").unregister(env({ exec, homeDir: emptyHome() })),
    "removed",
  );
  assert.equal(
    codexConfigPath({ homeDir: "/h", processEnv: { CODEX_HOME: "/c" } }),
    join("/c", "config.toml"),
  );
  assert.equal(
    codexConfigPath({ homeDir: "/h", processEnv: {} }),
    join("/h", ".codex", "config.toml"),
  );
  assert.equal(
    agyConfigPath({ homeDir: "/h" }),
    join("/h", ".gemini", "config", "mcp_config.json"),
  );
});

test("codex unregister reports failed (not an exception) when the TOML sweep itself throws", () => {
  const { home } = seededHome();
  const { exec } = fakeExec({ list: "pluriply" });
  const logs = [];
  const brokenFs = {
    existsSync: () => true,
    readFileSync: () => {
      throw new Error("EACCES: permission denied");
    },
  };
  assert.doesNotThrow(() => {
    const result = byId("codex").unregister(
      env({ exec, homeDir: home, fs: brokenFs, log: (m) => logs.push(m) }),
    );
    assert.equal(result, "failed");
  });
  assert.match(
    logs[0],
    /pluriply was removed from .* but leftover config could not be cleaned: EACCES/,
  );
});

test("JSON adapters unregister with a backup, keep other servers, and refuse corrupt files", () => {
  const home = emptyHome();
  const cd = byId("claude-desktop");
  const file = configPath("claude-desktop", {
    homeDir: home,
    platform: "linux",
  });
  mkdirSync(join(home, ".config", "Claude"), { recursive: true });
  const e = env({ homeDir: home, platform: "linux" });
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: { other: { command: "x" }, pluriply: { command: "n" } },
      theme: "dark",
    }),
  );
  assert.equal(cd.unregister(e), "removed");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    mcpServers: { other: { command: "x" } },
    theme: "dark",
  });
  assert.ok(existsSync(`${file}.bak`));
  assert.equal(cd.unregister(e), "absent");
  writeFileSync(
    file,
    JSON.stringify({ mcpServers: { pluriply: { command: "n" } } }),
  );
  assert.equal(cd.unregister(e), "removed");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mcpServers: {} });
  writeFileSync(file, "{not json");
  const logs = [];
  assert.equal(
    cd.unregister(
      env({ homeDir: home, platform: "linux", log: (m) => logs.push(m) }),
    ),
    "failed",
  );
  assert.equal(readFileSync(file, "utf8"), "{not json");
  assert.match(logs[0], /cannot update Claude Desktop config/);
  assert.equal(
    cd.unregister(
      env({
        homeDir: home,
        platform: "linux",
        processEnv: { PLURIPLY_SKIP_MCP_REGISTER: "1" },
      }),
    ),
    "skipped",
  );
});

test("codex register writes tool_timeout_sec under [mcp_servers.pluriply] and rolls back when it cannot", () => {
  assert.equal(TOOL_TIMEOUT_SEC, 600);
  const { home, codexToml } = seededHome();
  const { exec, calls } = fakeExec({ list: "nothing" });
  assert.equal(
    byId("codex").register(env({ exec, homeDir: home })),
    "registered",
  );
  assert.match(
    readFileSync(codexToml, "utf8"),
    /\[mcp_servers\.pluriply\]\ntool_timeout_sec = 600\ncommand = "node"/,
  );
  assert.match(
    readFileSync(codexToml, "utf8"),
    /\[mcp_servers\.other\]\ncommand = "x"/,
  );
  assert.ok(existsSync(`${codexToml}.bak`));
  assert.equal(calls.filter((c) => c[2] === "remove").length, 0);
  // 이미 있으면 보존하고 파일을 다시 쓰지 않는다
  writeFileSync(codexToml, "[mcp_servers.pluriply]\ntool_timeout_sec = 45\n");
  writeFileSync(`${codexToml}.bak`, "marker");
  assert.equal(
    byId("codex").register(env({ exec, homeDir: home })),
    "registered",
  );
  assert.equal(
    readFileSync(codexToml, "utf8"),
    "[mcp_servers.pluriply]\ntool_timeout_sec = 45\n",
  );
  assert.equal(readFileSync(`${codexToml}.bak`, "utf8"), "marker");
  // 헤더가 없으면 mcp remove 로 롤백하고 failed
  writeFileSync(codexToml, 'model = "gpt"\n');
  const logs = [];
  const r = byId("codex").register(
    env({ exec, homeDir: home, log: (m) => logs.push(m) }),
  );
  assert.match(r, /^failed: tool_timeout_sec not written/);
  assert.deepEqual(calls.at(-1), ["codex", "mcp", "remove", "pluriply"]);
  assert.equal(readFileSync(codexToml, "utf8"), 'model = "gpt"\n');
  assert.match(
    logs.at(-1),
    /could not configure Codex: tool_timeout_sec not written/,
  );
  // 파일 자체가 없어도 롤백. CODEX_HOME 을 따른다.
  const alt = emptyHome();
  assert.match(
    byId("codex").register(
      env({ exec, homeDir: home, processEnv: { CODEX_HOME: alt } }),
    ),
    /^failed: tool_timeout_sec not written/,
  );
  writeFileSync(join(alt, "config.toml"), "[mcp_servers.pluriply]\n");
  assert.equal(
    byId("codex").register(
      env({ exec, homeDir: home, processEnv: { CODEX_HOME: alt } }),
    ),
    "registered",
  );
  assert.match(
    readFileSync(join(alt, "config.toml"), "utf8"),
    /tool_timeout_sec = 600/,
  );
});

test("codex register warns when the rollback itself fails, leaving pluriply registered without a timeout", () => {
  const { exec } = fakeExec({ list: "nothing", removeThrows: true });
  const logs = [];
  const r = byId("codex").register(
    env({ exec, homeDir: emptyHome(), log: (m) => logs.push(m) }),
  );
  assert.match(r, /^failed: tool_timeout_sec not written/);
  assert.match(logs.at(-1), /registration left in place/);
});

test("codex register refuses and rolls back when config.toml contains a triple-quoted string anywhere", () => {
  const { home, codexToml } = seededHome();
  const withTripleQuotes =
    'developer_instructions = """\n[mcp_servers.pluriply]\nfake\n"""\n\n' +
    readFileSync(codexToml, "utf8");
  writeFileSync(codexToml, withTripleQuotes);
  const { exec, calls } = fakeExec({ list: "nothing" });
  const logs = [];
  const r = byId("codex").register(
    env({ exec, homeDir: home, log: (m) => logs.push(m) }),
  );
  assert.match(r, /^failed: tool_timeout_sec not written .*triple-quoted/);
  assert.deepEqual(calls.at(-1), ["codex", "mcp", "remove", "pluriply"]);
  assert.equal(readFileSync(codexToml, "utf8"), withTripleQuotes);
  assert.match(
    logs.at(-1),
    /could not configure Codex: tool_timeout_sec not written .*triple-quoted/,
  );
});

test("codex unregister hints instead of writing when config.toml contains a triple-quoted string and a leftover section", () => {
  const { home, codexToml } = seededHome();
  const withLeftover = [
    'developer_instructions = """',
    "[mcp_servers.pluriply]",
    "fake",
    '"""',
    "",
    "[mcp_servers.pluriply.tools.x]",
    'approval_mode = "approve"',
    "",
    "[mcp_servers.other]",
    'command = "x"',
    "",
  ].join("\n");
  writeFileSync(codexToml, withLeftover);
  const { exec } = fakeExec({ list: "pluriply" });
  const logs = [];
  assert.equal(
    byId("codex").unregister(
      env({ exec, homeDir: home, log: (m) => logs.push(m) }),
    ),
    "removed",
  );
  assert.equal(readFileSync(codexToml, "utf8"), withLeftover);
  assert.ok(!existsSync(`${codexToml}.bak`));
  assert.ok(logs.some((m) => /triple-quoted strings/.test(m)));
});

test("antigravity register writes timeoutSeconds into agy's mcp_config.json and rolls back on missing entry or JSONC", () => {
  const { home, agyJson } = seededHome();
  const { exec, calls } = fakeExec({ list: "nothing" });
  assert.equal(
    byId("antigravity").register(env({ exec, homeDir: home })),
    "registered",
  );
  const doc = JSON.parse(readFileSync(agyJson, "utf8"));
  assert.deepEqual(doc.mcpServers.pluriply, {
    command: "node",
    disabled: false,
    timeoutSeconds: 600,
  });
  assert.ok(existsSync(`${agyJson}.bak`));
  // 이미 있으면 보존
  writeFileSync(
    agyJson,
    JSON.stringify({
      mcpServers: { pluriply: { command: "node", timeoutSeconds: 30 } },
    }),
  );
  assert.equal(
    byId("antigravity").register(env({ exec, homeDir: home })),
    "registered",
  );
  assert.equal(
    JSON.parse(readFileSync(agyJson, "utf8")).mcpServers.pluriply
      .timeoutSeconds,
    30,
  );
  // 항목이 없으면(agy 가 다른 곳에 썼으면) 롤백
  writeFileSync(agyJson, JSON.stringify({ mcpServers: {} }));
  assert.match(
    byId("antigravity").register(env({ exec, homeDir: home })),
    /^failed: timeoutSeconds not written/,
  );
  assert.deepEqual(calls.at(-1).slice(1), ["mcp", "remove", "pluriply"]);
  // JSONC(주석) 는 파싱 실패 → 롤백, 파일 불변
  writeFileSync(agyJson, '{ // c\n "mcpServers": { "pluriply": {} } }');
  assert.match(
    byId("antigravity").register(env({ exec, homeDir: home })),
    /^failed: timeoutSeconds not written/,
  );
  assert.match(readFileSync(agyJson, "utf8"), /\/\/ c/);
  // 파일이 없어도 롤백
  assert.match(
    byId("antigravity").register(env({ exec, homeDir: emptyHome() })),
    /^failed: timeoutSeconds not written/,
  );
});

test("antigravity-ide entries carry timeoutSeconds, claude-desktop entries do not", () => {
  const home = emptyHome();
  mkdirSync(join(home, ".gemini", "antigravity-ide"), { recursive: true });
  const ideFile = join(home, ".gemini", "antigravity-ide", "mcp_config.json");
  writeFileSync(ideFile, "");
  const e = env({ homeDir: home, platform: "linux" });
  assert.equal(byId("antigravity-ide").register(e), "registered");
  assert.deepEqual(
    JSON.parse(readFileSync(ideFile, "utf8")).mcpServers.pluriply,
    {
      command: "/usr/bin/node",
      args: [BIN, "connector", "--agent", "antigravity-ide"],
      timeoutSeconds: 600,
    },
  );
  mkdirSync(join(home, ".config", "Claude"), { recursive: true });
  const cdFile = configPath("claude-desktop", {
    homeDir: home,
    platform: "linux",
  });
  writeFileSync(cdFile, "");
  assert.equal(byId("claude-desktop").register(e), "registered");
  assert.equal(
    JSON.parse(readFileSync(cdFile, "utf8")).mcpServers.pluriply.timeoutSeconds,
    undefined,
  );
});

test("claude-code status follows CLAUDE_CONFIG_DIR instead of the home directory", () => {
  const cc = byId("claude-code");
  const dir = claudeJsonHome({ mcpServers: { pluriply: {} } });
  // homeDir 은 비어 있다: 파일을 찾았다면 CLAUDE_CONFIG_DIR 를 본 것이다.
  assert.equal(
    cc.status(
      env({
        exec: fakeExec({ list: "nothing" }).exec,
        homeDir: emptyHome(),
        processEnv: { CLAUDE_CONFIG_DIR: dir },
      }),
    ),
    "present",
  );

  // 변수가 가리키는 폴더에 파일이 없으면 missing — 홈에 있는 파일로 새어 나가면 안 된다.
  const homeWithFile = claudeJsonHome({ mcpServers: { pluriply: {} } });
  assert.equal(
    cc.status(
      env({
        exec: fakeExec({ list: "nothing" }).exec,
        homeDir: homeWithFile,
        processEnv: { CLAUDE_CONFIG_DIR: emptyHome() },
      }),
    ),
    "missing",
  );

  // 빈 문자열은 설정되지 않은 것과 같다(홈으로 폴백)
  assert.equal(
    cc.status(
      env({
        exec: fakeExec({ list: "nothing" }).exec,
        homeDir: homeWithFile,
        processEnv: { CLAUDE_CONFIG_DIR: "" },
      }),
    ),
    "present",
  );

  // 키의 값이 아니라 키의 존재로 판정한다(Object.hasOwn) — 값이 null 이어도 등록된 항목이다.
  assert.equal(
    cc.status(
      env({
        exec: fakeExec({ list: "nothing" }).exec,
        homeDir: claudeJsonHome({ mcpServers: { pluriply: null } }),
      }),
    ),
    "present",
  );
  // mcpServers 가 객체가 아니면 missing (hasOwn 이 던지지 않도록)
  assert.equal(
    cc.status(
      env({
        exec: fakeExec({ list: "nothing" }).exec,
        homeDir: claudeJsonHome({ mcpServers: "nope" }),
      }),
    ),
    "missing",
  );
});

/** 파일의 권한 비트만. 0600 처럼 사용자가 잠근 설정이 넓어지지 않았는지 본다. */
const modeOf = (p) => statSync(p).mode & 0o777;

test("atomic writes keep the original file mode on both the file and its .bak", (t) => {
  if (skipOnWindows(t, "POSIX file modes do not exist on Windows")) return;
  // 이 설정 파일들엔 API 키·다른 MCP 서버의 env 가 들어 있어 0600 으로 잠가두는 일이 흔하다.
  // tmp+rename 이 기본 모드(umask 022 → 0644)로 쓰면 전체 읽기로 넓어진다.
  const { home, codexToml } = seededHome();
  chmodSync(codexToml, 0o600);
  const { exec } = fakeExec({ list: "nothing" });
  assert.equal(
    byId("codex").register(env({ exec, homeDir: home })),
    "registered",
  );
  assert.match(readFileSync(codexToml, "utf8"), /tool_timeout_sec = 600/);
  assert.equal(modeOf(codexToml), 0o600);
  assert.equal(modeOf(`${codexToml}.bak`), 0o600);

  // 해제(afterRemove 의 TOML 청소)도 같은 경로를 탄다.
  const rm = fakeExec({ list: "pluriply" });
  assert.equal(
    byId("codex").unregister(env({ exec: rm.exec, homeDir: home })),
    "removed",
  );
  assert.doesNotMatch(readFileSync(codexToml, "utf8"), /pluriply/);
  assert.equal(modeOf(codexToml), 0o600);
  assert.equal(modeOf(`${codexToml}.bak`), 0o600);

  // JSON 어댑터(writeJsonAtomic)도 같은 헬퍼를 쓴다.
  const jsonHome = emptyHome();
  mkdirSync(join(jsonHome, ".config", "Claude"), { recursive: true });
  const cdPath = configPath("claude-desktop", {
    homeDir: jsonHome,
    platform: "linux",
  });
  writeFileSync(cdPath, JSON.stringify({ mcpServers: { other: {} } }));
  chmodSync(cdPath, 0o600);
  const cd = byId("claude-desktop");
  assert.equal(
    cd.register(env({ homeDir: jsonHome, platform: "linux" })),
    "registered",
  );
  assert.equal(modeOf(cdPath), 0o600);
  assert.equal(modeOf(`${cdPath}.bak`), 0o600);
  assert.equal(
    cd.unregister(env({ homeDir: jsonHome, platform: "linux" })),
    "removed",
  );
  assert.equal(modeOf(cdPath), 0o600);
});

test("atomic writes go through a symlinked config instead of replacing the link", (t) => {
  // dotfiles 저장소로 링크된 ~/.codex/config.toml. 링크를 일반 파일로 갈아치우면 dotfiles 사본이
  // 더는 갱신되지 않는다. 전부 임시 디렉터리 안이다 — 진짜 ~/.codex 는 건드리지 않는다.
  const home = emptyHome();
  if (!skipUnlessSymlinks(t, home)) return;
  const dotfiles = join(home, "dotfiles");
  mkdirSync(dotfiles);
  const realToml = join(dotfiles, "config.toml");
  writeFileSync(
    realToml,
    'model = "gpt"\n\n[mcp_servers.pluriply]\ncommand = "node"\n',
  );
  mkdirSync(join(home, ".codex"));
  const linked = join(home, ".codex", "config.toml");
  symlinkSync(realToml, linked);

  const { exec } = fakeExec({ list: "nothing" });
  assert.equal(
    byId("codex").register(env({ exec, homeDir: home })),
    "registered",
  );
  assert.equal(lstatSync(linked).isSymbolicLink(), true);
  assert.match(readFileSync(realToml, "utf8"), /tool_timeout_sec = 600/);
  // 백업도 실제 파일 옆에 생긴다 — 링크가 있던 폴더가 아니다.
  assert.ok(existsSync(`${realToml}.bak`));
  assert.equal(existsSync(`${linked}.bak`), false);
  // 임시 파일은 남지 않는다.
  assert.equal(existsSync(`${realToml}.${process.pid}.tmp`), false);
});
