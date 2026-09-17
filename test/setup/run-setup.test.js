import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join, dirname, resolve, parse } from "node:path";
import {
  runSetup,
  formatSetup,
  REMOVE_NOTE,
  HOOKS_ONLY_NOTE,
} from "../../src/setup/run-setup.js";
import { makeEnv, configPath } from "../../src/setup/clients.js";
import { TEMPLATE_AGENTS } from "../../src/shared/config.js";
import { emptyHome, seededHome } from "../fixtures/seeded-home.js";
import { skipUnlessSymlinks } from "../fixtures/platform.js";
import { HOOK_CLIENTS } from "../../src/setup/hooks.js";

const BIN = "/opt/pluriply/bin/pluriply.js";

/**
 * 다섯 클라이언트가 전부 설치·등록된 것처럼 보이는 사용자 홈(platform linux 경로).
 * claudeCode=false 면 ~/.claude.json 을 아예 안 둬서 claude-code 만 미등록으로 남긴다
 * (claude-code 의 status 는 `mcp list` 가 아니라 이 파일의 user-scope 항목을 본다 — 스코프 인식 override).
 */
function fullUserHome({ claudeCode = true } = {}) {
  const { home } = seededHome();
  if (claudeCode) {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { pluriply: { command: "n" } } }),
    );
  }
  const cd = configPath("claude-desktop", { homeDir: home, platform: "linux" });
  mkdirSync(join(home, ".config", "Claude"), { recursive: true });
  writeFileSync(
    cd,
    JSON.stringify({
      mcpServers: { other: { command: "x" }, pluriply: { command: "n" } },
    }),
  );
  mkdirSync(join(home, ".gemini", "antigravity-ide"), { recursive: true });
  const ide = join(home, ".gemini", "antigravity-ide", "mcp_config.json");
  writeFileSync(
    ide,
    JSON.stringify({ mcpServers: { pluriply: { command: "n" } } }),
  );
  return { home, cd, ide };
}

function fakeExec({ list = "pluriply" } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "--version") return Buffer.from("1\n");
    if (args[1] === "list") return Buffer.from(list);
    return Buffer.from("");
  };
  return { exec, calls };
}

function setup({
  list,
  stop = "stopped",
  stopHub,
  configDoc,
  claudeCode,
} = {}) {
  const user = fullUserHome({ claudeCode });
  const home = emptyHome();
  if (configDoc === undefined) {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        workers: { codex: { enabled: true }, antigravity: { enabled: true } },
        allowedRoots: ["/abs"],
      }),
    );
  } else if (configDoc === "dir") {
    mkdirSync(join(home, "config.json"));
  }
  const { exec, calls } = fakeExec({ list });
  const stopCalls = [];
  const rmCalls = [];
  const env = makeEnv({
    binPath: BIN,
    log: () => {},
    processEnv: {},
    node: "/usr/bin/node",
    homeDir: user.home,
    platform: "linux",
    exec,
    stopHub:
      stopHub ??
      (async ({ home: h }) => {
        stopCalls.push(h);
        return stop;
      }),
    rm: (p) => rmCalls.push(p),
  });
  return { user, home, env, calls, stopCalls, rmCalls };
}

const results = (r) => Object.fromEntries(r.rows.map((x) => [x.id, x.result]));

/** 가드가 쓰는 것과 같은 정규화 — macOS 임시 경로는 /var → /private/var 로 풀린다. */
const canon = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/**
 * purge 를 한 번 돌린다. `over` 로 env 를 덮어쓴다(userHome·platform 주입).
 * rm 은 언제나 가짜다 — 어떤 테스트도 진짜 경로를 지우지 않는다.
 */
async function purgeRun(home, over = {}) {
  const s = setup();
  const r = await runSetup({
    remove: true,
    purge: true,
    env: { ...s.env, ...over },
    home,
  });
  return { r, rmCalls: s.rmCalls };
}

test("full remove unregisters every client, disables all workers, stops the hub, and prints the note", async () => {
  const { user, home, env, calls, stopCalls, rmCalls } = setup();
  const r = await runSetup({ remove: true, env, home });
  assert.equal(r.mode, "remove");
  assert.deepEqual(results(r), {
    "claude-code": "removed",
    codex: "removed",
    antigravity: "removed",
    "claude-desktop": "removed",
    "antigravity-ide": "removed",
  });
  assert.equal(r.failed, 0);
  assert.deepEqual(r.workersDisabled, [...TEMPLATE_AGENTS]);
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.deepEqual(cfg, { workers: {}, allowedRoots: ["/abs"] });
  assert.equal(r.hub, "stopped");
  assert.deepEqual(stopCalls, [home]);
  assert.equal(r.purge, undefined);
  assert.deepEqual(rmCalls, []);
  assert.equal(r.note, REMOVE_NOTE);
  assert.equal(calls.filter((c) => c[2] === "remove").length, 3);
  assert.deepEqual(JSON.parse(readFileSync(user.cd, "utf8")), {
    mcpServers: { other: { command: "x" } },
  });
  assert.deepEqual(JSON.parse(readFileSync(user.ide, "utf8")), {
    mcpServers: {},
  });
  const lines = formatSetup(r);
  assert.match(lines[0], /^claude-code\s+installed\s+removed$/);
  assert.ok(lines.includes(`workers disabled: ${TEMPLATE_AGENTS.join(", ")}`));
  assert.ok(lines.includes("hub: stopped"));
  assert.equal(lines.at(-1), REMOVE_NOTE);
  assert.ok(!lines.some((l) => l.startsWith("hint:")));
});

test("dry-run remove plans without touching anything, and --purge only reports the path", async () => {
  const { user, home, env, calls, stopCalls, rmCalls } = setup();
  const before = readFileSync(user.cd, "utf8");
  const r = await runSetup({
    remove: true,
    purge: true,
    dryRun: true,
    env,
    home,
  });
  assert.deepEqual(results(r), {
    "claude-code": "planned",
    codex: "planned",
    antigravity: "planned",
    "claude-desktop": "planned",
    "antigravity-ide": "planned",
  });
  assert.equal(readFileSync(user.cd, "utf8"), before);
  assert.equal(calls.filter((c) => c[2] === "remove").length, 0);
  assert.deepEqual(stopCalls, []);
  assert.deepEqual(rmCalls, []);
  assert.equal(r.hub, undefined);
  assert.deepEqual(r.workersDisabled, []);
  assert.equal(r.purge, `planned ${home}`);
  assert.equal(
    JSON.parse(readFileSync(join(home, "config.json"), "utf8")).workers.codex
      .enabled,
    true,
  );
  assert.ok(formatSetup(r).includes(`purge: planned ${home}`));
});

test("--only removes just those clients, disables only their workers, and leaves the hub alone", async () => {
  const { home, env, stopCalls } = setup();
  const r = await runSetup({
    remove: true,
    only: ["codex", "claude-desktop"],
    env,
    home,
  });
  assert.deepEqual(results(r), {
    codex: "removed",
    "claude-desktop": "removed",
  });
  // 워커 비활성화는 행 결과("removed")가 아니라 겨냥한 CLI 템플릿 에이전트 목록으로 정해진다 —
  // claude-desktop 은 kind:"config" 라서 TEMPLATE_AGENTS 에 없어 애초에 후보가 아니다.
  assert.deepEqual(r.workersDisabled, ["codex"]);
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(cfg.workers.codex, undefined);
  assert.equal(cfg.workers.antigravity.enabled, true);
  assert.equal(r.hub, undefined);
  assert.deepEqual(stopCalls, []);
  assert.equal(r.note, undefined);
  assert.ok(!formatSetup(r).some((l) => l.startsWith("hub:")));
});

test("--only claude-code disables the worker even when its MCP registration is already absent", async () => {
  // 재현: `worker enable claude-code` 로 config.json 에는 enabled:true 로 남아 있는데
  // ~/.claude.json 자체가 없어(등록 이전이거나 지워져) status 가 "missing" → unregister 는
  // "absent" 를 돌려준다. 예전 로직은 row 결과가 "removed" 일 때만 비활성화해서 이 경우
  // config.json 에 enabled:true 인 워커가 그대로 남았다(허브는 --only 에서 멈추지 않으므로
  // 계속 작업을 받는다).
  const { home, env } = setup({ claudeCode: false, configDoc: "custom" });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      workers: { "claude-code": { enabled: true } },
      allowedRoots: [],
    }),
  );
  const r = await runSetup({
    remove: true,
    only: ["claude-code"],
    env,
    home,
  });
  assert.equal(results(r)["claude-code"], "absent");
  assert.deepEqual(r.workersDisabled, ["claude-code"]);
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(Object.hasOwn(cfg.workers, "claude-code"), false);
});

test("dry-run --only never plans a purge, even when --purge is passed (the hub is left alone)", async () => {
  const { home, env } = setup();
  const r = await runSetup({
    remove: true,
    only: ["codex"],
    purge: true,
    dryRun: true,
    env,
    home,
  });
  assert.equal(r.purge, undefined);
});

test("hub stop rejection is contained: rows are still returned, hubError recorded, no purge, note still printed", async () => {
  const { home, env, rmCalls } = setup({
    stopHub: async () => {
      throw new Error("boom");
    },
  });
  const r = await runSetup({ remove: true, purge: true, env, home });
  assert.deepEqual(results(r), {
    "claude-code": "removed",
    codex: "removed",
    antigravity: "removed",
    "claude-desktop": "removed",
    "antigravity-ide": "removed",
  });
  assert.equal(r.hub, undefined);
  assert.equal(r.hubError, "boom");
  assert.equal(r.failed, 1);
  assert.equal(r.purge, undefined);
  assert.deepEqual(rmCalls, []);
  assert.equal(r.note, REMOVE_NOTE);
  assert.ok(formatSetup(r).includes("hub: could not stop (boom)"));
});

test("setWorkerEnabled failure during full remove is contained: rows returned, workersError recorded, hub still stopped", async () => {
  const { home, env, stopCalls } = setup({ configDoc: "dir" });
  const r = await runSetup({ remove: true, env, home });
  assert.deepEqual(results(r), {
    "claude-code": "removed",
    codex: "removed",
    antigravity: "removed",
    "claude-desktop": "removed",
    "antigravity-ide": "removed",
  });
  assert.deepEqual(r.workersDisabled, []);
  assert.match(r.workersError, /EISDIR|EPERM/);
  assert.equal(r.failed, 1);
  assert.equal(r.hub, "stopped");
  assert.deepEqual(stopCalls, [home]);
  assert.equal(r.note, REMOVE_NOTE);
  assert.ok(
    formatSetup(r).some((l) =>
      l.startsWith("workers: could not update config ("),
    ),
  );
});

test("purge removes the pluriply home after the hub stopped or was not running, but not on timeout", async () => {
  const a = setup({ stop: "stopped" });
  let r = await runSetup({
    remove: true,
    purge: true,
    env: a.env,
    home: a.home,
  });
  // 가드는 정규화된 경로로 판정하지만 rm 은 정규화하지 않은 경로를 받는다 — 홈이 심볼릭 링크일 때
  // realpath 를 지우면 링크가 가리키는 바깥 디렉터리가 통째로 날아가기 때문이다.
  assert.deepEqual(a.rmCalls, [resolve(a.home)]);
  assert.equal(r.purge, `removed ${a.home}`);
  assert.equal(r.failed, 0);

  const b = setup({ stop: "not-running" });
  r = await runSetup({ remove: true, purge: true, env: b.env, home: b.home });
  assert.equal(r.hub, "not-running");
  assert.deepEqual(b.rmCalls, [resolve(b.home)]);
  assert.ok(formatSetup(r).includes("hub: not running"));

  const c = setup({ stop: "timeout" });
  writeFileSync(
    join(c.home, "hub.json"),
    JSON.stringify({ pid: 4242, port: 1 }),
  );
  r = await runSetup({ remove: true, purge: true, env: c.env, home: c.home });
  assert.equal(r.hub, "timeout");
  assert.equal(r.hubPid, 4242);
  assert.equal(r.failed, 1);
  assert.equal(r.purge, undefined);
  assert.deepEqual(c.rmCalls, []);
  assert.ok(
    formatSetup(r).includes("hub: failed to stop within 5s (pid 4242)"),
  );
});

test("absent, corrupt, and not-installed clients are reported without stopping the run", async () => {
  const { user, home, env } = setup({
    list: "nothing here",
    claudeCode: false,
  });
  writeFileSync(user.ide, "{not json");
  const r = await runSetup({ remove: true, env, home });
  assert.equal(results(r)["claude-code"], "absent");
  assert.equal(results(r)["claude-desktop"], "removed");
  assert.match(results(r)["antigravity-ide"], /^failed: /);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.workersDisabled, [...TEMPLATE_AGENTS]);
  assert.equal(r.hub, "stopped");
  const noConfig = emptyHome();
  const r2 = await runSetup({ remove: true, env, home: noConfig });
  assert.deepEqual(r2.workersDisabled, []);
  assert.equal(existsSync(join(noConfig, "config.json")), false);
});

test("register mode still enables workers through setWorkerEnabled and skips the hub on dry-run", async () => {
  const { home, env } = setup({ list: "nothing" });
  const r = await runSetup({
    only: ["codex"],
    workers: true,
    dryRun: true,
    env,
    home,
  });
  assert.deepEqual(results(r), { codex: "planned" });
  assert.deepEqual(r.workers, []);
  assert.equal(r.hub, undefined);
});

test("purge refuses the injected user home and a filesystem root", async () => {
  const userHome = emptyHome();
  const a = await purgeRun(userHome, { userHome });
  assert.equal(
    a.r.purgeError,
    `${canon(userHome)} resolves to your home directory`,
  );
  assert.equal(a.r.failed, 1);
  assert.equal(a.r.purge, undefined);
  assert.deepEqual(a.rmCalls, []);
  assert.ok(formatSetup(a.r).includes(`purge: refused (${a.r.purgeError})`));
  assert.equal(existsSync(userHome), true);

  const root = parse(process.cwd()).root;
  const b = await purgeRun(root, { userHome });
  assert.equal(b.r.purgeError, `${root} is a filesystem root`);
  assert.equal(b.r.failed, 1);
  assert.equal(b.r.purge, undefined);
  assert.deepEqual(b.rmCalls, []);
  assert.ok(
    formatSetup(b.r).includes(`purge: refused (${root} is a filesystem root)`),
  );
});

test("purge follows symlinks before judging: a link onto an ancestor of the user home is refused", async (t) => {
  // 전부 임시 디렉터리 안에서만 논다 — 진짜 홈으로 향하는 링크는 만들지 않는다.
  const tmp = emptyHome();
  if (!skipUnlessSymlinks(t, tmp)) return;
  const homes = join(tmp, "homes");
  const userHome = join(homes, "alice");
  mkdirSync(userHome, { recursive: true });
  const link = join(tmp, "users-alias"); // → <tmp>/homes
  symlinkSync(homes, link);

  const { r, rmCalls } = await purgeRun(link, { userHome });
  assert.equal(r.purgeError, `${canon(homes)} contains your home directory`);
  assert.equal(r.failed, 1);
  assert.equal(r.purge, undefined);
  assert.deepEqual(rmCalls, []);
  assert.ok(formatSetup(r).includes(`purge: refused (${r.purgeError})`));
  assert.equal(existsSync(userHome), true);
});

test("purge refuses a case-variant of the user home on case-insensitive platforms only", async () => {
  const root = parse(process.cwd()).root;
  const userHome = join(root, "Users", "pluriply-not-a-real-user");
  const variant = join(root, "users", "PLURIPLY-NOT-A-REAL-USER");

  const mac = await purgeRun(variant, { userHome, platform: "darwin" });
  assert.equal(mac.r.purgeError, `${variant} resolves to your home directory`);
  assert.deepEqual(mac.rmCalls, []);

  // 대소문자를 구분하는 파일시스템에서는 다른 경로다 — 가드가 무턱대고 막지는 않는다.
  const lin = await purgeRun(variant, { userHome, platform: "linux" });
  assert.equal(lin.r.purgeError, undefined);
});

test("purge refuses an ancestor of the user home and one-segment top-level paths", async () => {
  const userHome = join(
    parse(process.cwd()).root,
    "srv",
    "plp-not-a-real-home",
  );
  const parent = dirname(userHome);
  const up = await purgeRun(parent, { userHome });
  assert.equal(
    up.r.purgeError,
    `${canon(parent)} contains your home directory`,
  );
  assert.deepEqual(up.rmCalls, []);

  for (const name of ["Users", "home", "etc"]) {
    const p = join(parse(process.cwd()).root, name);
    const t = await purgeRun(p, { userHome });
    const expected = existsSync(p) ? canon(p) : resolve(p);
    assert.equal(t.r.purgeError, `${expected} is a top-level directory`, p);
    assert.equal(t.r.purge, undefined, p);
    assert.deepEqual(t.rmCalls, [], p);
  }
});

test("dry-run applies the same guard instead of promising to delete the user home", async () => {
  const userHome = emptyHome();
  const s = setup();
  const r = await runSetup({
    remove: true,
    purge: true,
    dryRun: true,
    env: { ...s.env, userHome },
    home: userHome,
  });
  assert.equal(
    r.purgeError,
    `${canon(userHome)} resolves to your home directory`,
  );
  assert.equal(r.failed, 1);
  assert.equal(r.purge, undefined);
  assert.deepEqual(s.rmCalls, []);
  assert.ok(formatSetup(r).includes(`purge: refused (${r.purgeError})`));
  assert.equal(existsSync(userHome), true);
});

test("purge still deletes a real pluriply home, and rm gets the raw resolved path", async () => {
  const parent = emptyHome();
  const home = join(parent, ".pluriply");
  mkdirSync(home);
  const { r, rmCalls } = await purgeRun(home, { userHome: emptyHome() });
  assert.equal(r.purgeError, undefined);
  assert.equal(r.purge, `removed ${home}`);
  assert.equal(r.failed, 0);
  assert.deepEqual(rmCalls, [resolve(home)]);
});

test("dry-run honours PLURIPLY_SKIP_MCP_REGISTER: every installed client reports skipped, and no mcp list calls are made, in remove and register modes alike", async () => {
  const { env, calls } = setup();
  const skipEnv = { ...env, processEnv: { PLURIPLY_SKIP_MCP_REGISTER: "1" } };

  const removeResult = await runSetup({
    remove: true,
    dryRun: true,
    env: skipEnv,
    home: emptyHome(),
  });
  assert.deepEqual(results(removeResult), {
    "claude-code": "skipped",
    codex: "skipped",
    antigravity: "skipped",
    "claude-desktop": "skipped",
    "antigravity-ide": "skipped",
  });

  const registerResult = await runSetup({
    dryRun: true,
    env: skipEnv,
    home: emptyHome(),
  });
  assert.deepEqual(results(registerResult), {
    "claude-code": "skipped",
    codex: "skipped",
    antigravity: "skipped",
    "claude-desktop": "skipped",
    "antigravity-ide": "skipped",
  });

  // status() 는 CLI 세 도구에 한해 `... mcp list` 를 실행한다 — 스킵이 dry-run 에서도 먹혔다면
  // 이 호출 자체가 없어야 한다(F4: 이전엔 dry-run 이 실제로 list 를 쳐서 실행 결과와 어긋났다).
  assert.equal(calls.filter((c) => c.includes("list")).length, 0);
});

test("purge unlinks a symlinked pluriply home instead of wiping the directory it points at", async (t) => {
  // 전부 임시 디렉터리 안에서만 논다 — 진짜 홈이나 진짜 ~/.pluriply 는 건드리지 않는다.
  const parent = emptyHome();
  if (!skipUnlessSymlinks(t, parent)) return;
  const real = join(emptyHome(), "real-pluriply-data");
  mkdirSync(real);
  writeFileSync(join(real, "keep.txt"), "keep me");
  const link = join(parent, ".pluriply"); // → <다른 tmp>/real-pluriply-data
  symlinkSync(real, link);

  const { r, rmCalls } = await purgeRun(link, { userHome: emptyHome() });
  assert.equal(r.purgeError, undefined);
  assert.equal(r.failed, 0);
  // rm 은 링크 경로 그대로 받는다(정규화된 <tmp>/real-pluriply-data 가 아니다).
  assert.deepEqual(rmCalls, [resolve(link)]);
  assert.notEqual(resolve(link), canon(link));
  assert.equal(r.purge, `removed ${link} (symlink unlinked; target kept)`);
  assert.ok(
    formatSetup(r).includes(
      `purge: removed ${link} (symlink unlinked; target kept)`,
    ),
  );
  // rm 은 가짜라 실제로 지워지지 않았지만, 링크 대상이 삭제 대상이 아니었음을 남겨둔다.
  assert.equal(readFileSync(join(real, "keep.txt"), "utf8"), "keep me");
});

function hookFile(env, id) {
  return HOOK_CLIENTS.find((h) => h.id === id).file(env);
}
function hookResults(r) {
  return Object.fromEntries(r.hookRows.map((x) => [x.id, x.result]));
}

test("setup installs Stop hooks for claude-code and codex by default, reports them, and is idempotent", async () => {
  const { home, env } = setup();
  mkdirSync(join(env.homeDir, ".claude"), { recursive: true });
  mkdirSync(join(env.homeDir, ".codex"), { recursive: true });
  const r = await runSetup({ env, home });
  assert.deepEqual(hookResults(r), {
    "claude-code": "registered",
    codex: "registered",
    antigravity: "registered",
  });
  assert.equal(existsSync(hookFile(env, "claude-code")), true);
  assert.equal(existsSync(hookFile(env, "codex")), true);
  assert.equal(existsSync(hookFile(env, "antigravity")), true);
  const lines = formatSetup(r);
  assert.ok(
    lines.some((l) => /^hooks claude-code\s+installed\s+registered$/.test(l)),
    lines.join("\n"),
  );
  assert.ok(
    lines.includes(
      "hint: Codex asks to trust the new hook in its next session — approve it.",
    ),
  );
  const again = await runSetup({ env, home });
  assert.deepEqual(hookResults(again), {
    "claude-code": "present",
    codex: "present",
    antigravity: "present",
  });
  assert.ok(!formatSetup(again).some((l) => l.startsWith("hint: Codex asks")));
});

test("setup --no-hooks skips hooks, --dry-run plans them, --only limits them, and hooks are not attempted for tools that are not installed", async () => {
  const { home, env } = setup();
  mkdirSync(join(env.homeDir, ".claude"), { recursive: true });
  mkdirSync(join(env.homeDir, ".codex"), { recursive: true });
  assert.deepEqual(hookResults(await runSetup({ env, home, hooks: false })), {
    "claude-code": "skipped",
    codex: "skipped",
    antigravity: "skipped",
  });
  assert.equal(existsSync(hookFile(env, "claude-code")), false);
  assert.deepEqual(hookResults(await runSetup({ env, home, dryRun: true })), {
    "claude-code": "planned",
    codex: "planned",
    antigravity: "planned",
  });
  assert.equal(existsSync(hookFile(env, "claude-code")), false);
  assert.deepEqual(
    hookResults(await runSetup({ env, home, only: ["codex"] })),
    { codex: "registered" },
  );
  assert.deepEqual(
    hookResults(await runSetup({ env, home, only: ["claude-desktop"] })),
    {},
  );
  // 도구가 설치돼 있지 않으면(감지 실패) 훅 행은 not installed
  const { exec } = fakeExec();
  const missing = makeEnv({
    ...env,
    exec: (cmd, args) => {
      if (cmd === "codex") throw new Error("ENOENT");
      return exec(cmd, args);
    },
  });
  const r = await runSetup({ env: missing, home });
  assert.equal(hookResults(r).codex, "not installed");
});

test("setup --remove removes the hooks it installed and leaves other hook groups alone", async () => {
  const { home, env } = setup();
  mkdirSync(join(env.homeDir, ".claude"), { recursive: true });
  mkdirSync(join(env.homeDir, ".codex"), { recursive: true });
  writeFileSync(
    hookFile(env, "codex"),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/bin/echo other" }] }],
      },
    }),
  );
  await runSetup({ env, home });
  const r = await runSetup({ env, home, remove: true });
  assert.deepEqual(hookResults(r), {
    "claude-code": "removed",
    codex: "removed",
    antigravity: "removed",
  });
  assert.deepEqual(
    JSON.parse(readFileSync(hookFile(env, "codex"), "utf8")).hooks.Stop,
    [{ hooks: [{ type: "command", command: "/bin/echo other" }] }],
  );
  assert.deepEqual(hookResults(await runSetup({ env, home, remove: true })), {
    "claude-code": "absent",
    codex: "absent",
    antigravity: "absent",
  });
  assert.deepEqual(
    hookResults(await runSetup({ env, home, remove: true, dryRun: true })),
    { "claude-code": "absent", codex: "absent", antigravity: "absent" },
  );
});

test("hooksOnly installs only the Stop hooks: no MCP writes, no worker change, no hub", async () => {
  const { user, home, env, calls } = setup();
  mkdirSync(join(env.homeDir, ".claude"), { recursive: true });
  mkdirSync(join(env.homeDir, ".codex"), { recursive: true });
  const before = readFileSync(user.cd, "utf8");
  const configBefore = readFileSync(join(home, "config.json"), "utf8");

  const r = await runSetup({ env, home, hooksOnly: true });
  assert.equal(r.mode, "hooks-only");
  assert.deepEqual(r.rows, []);
  assert.deepEqual(hookResults(r), {
    "claude-code": "registered",
    codex: "registered",
    antigravity: "registered",
  });
  assert.equal(r.hub, undefined);
  assert.equal(existsSync(join(home, "hub.json")), false); // 허브를 띄우지 않았다
  assert.equal(readFileSync(user.cd, "utf8"), before); // MCP 설정 파일 그대로
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), configBefore); // 워커 설정 그대로
  // detect 는 `--version` 만 부른다. add/remove/list 같은 MCP 등록 명령은 없어야 한다.
  assert.ok(
    calls.every(([, ...args]) => args[0] === "--version"),
    JSON.stringify(calls),
  );

  const lines = formatSetup(r);
  assert.equal(lines[0], HOOKS_ONLY_NOTE);
  assert.ok(
    lines.some((l) => /^hooks claude-code\s+installed\s+registered$/.test(l)),
  );
  assert.ok(
    !lines.some((l) => /^hub:|^workers|^hint: run/.test(l)),
    lines.join("\n"),
  );
  assert.ok(
    lines.includes(
      "hint: Codex asks to trust the new hook in its next session — approve it.",
    ),
  );
});

test("hooksOnly remove takes only the hooks out and leaves MCP registration, workers and the hub alone", async () => {
  const { user, home, env, stopCalls } = setup();
  mkdirSync(join(env.homeDir, ".claude"), { recursive: true });
  mkdirSync(join(env.homeDir, ".codex"), { recursive: true });
  await runSetup({ env, home, hooksOnly: true });
  const before = readFileSync(user.cd, "utf8");

  const r = await runSetup({ env, home, hooksOnly: true, remove: true });
  assert.equal(r.mode, "hooks-only-remove");
  assert.deepEqual(hookResults(r), {
    "claude-code": "removed",
    codex: "removed",
    antigravity: "removed",
  });
  assert.deepEqual(stopCalls, []);
  assert.deepEqual(r.workersDisabled, []);
  assert.equal(r.note, undefined);
  assert.equal(readFileSync(user.cd, "utf8"), before);
  assert.equal(
    JSON.parse(readFileSync(join(home, "config.json"), "utf8")).workers.codex
      .enabled,
    true,
  );
  const lines = formatSetup(r);
  assert.equal(lines[0], HOOKS_ONLY_NOTE);
  assert.ok(
    !lines.some((l) => /^hub:|^workers disabled|^note:/.test(l)),
    lines.join("\n"),
  );
});

test("hooksOnly honours --dry-run and --only", async () => {
  const { home, env } = setup();
  mkdirSync(join(env.homeDir, ".claude"), { recursive: true });
  mkdirSync(join(env.homeDir, ".codex"), { recursive: true });
  const dry = await runSetup({ env, home, hooksOnly: true, dryRun: true });
  assert.deepEqual(hookResults(dry), {
    "claude-code": "planned",
    codex: "planned",
    antigravity: "planned",
  });
  assert.equal(existsSync(hookFile(env, "claude-code")), false);

  const only = await runSetup({ env, home, hooksOnly: true, only: ["codex"] });
  assert.deepEqual(hookResults(only), { codex: "registered" });
  assert.equal(existsSync(hookFile(env, "claude-code")), false);
  assert.equal(existsSync(hookFile(env, "codex")), true);

  const dryRemove = await runSetup({
    env,
    home,
    hooksOnly: true,
    remove: true,
    dryRun: true,
    only: ["codex"],
  });
  assert.deepEqual(hookResults(dryRemove), { codex: "planned" });
  assert.equal(existsSync(hookFile(env, "codex")), true);
});
