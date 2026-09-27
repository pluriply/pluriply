import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pidAlive } from "../../src/shared/probe.js";
import {
  hasCdFlag,
  tuiArgs,
  runCodex,
  pluriplyRegistered,
} from "../../src/launcher/codex.js";

const FAKE = fileURLToPath(
  new URL("../fixtures/fake-codex.js", import.meta.url),
);
const skipWin = process.platform === "win32" ? "unix sockets only" : false;

function setup(extraEnv = {}) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "plp-lt-")));
  const home = mkdtempSync(join(tmpdir(), "plp-lh-"));
  const out = join(home, "calls.jsonl");
  const userHome = mkdtempSync(join(tmpdir(), "plp-lu-"));
  mkdirSync(join(userHome, ".codex"), { recursive: true });
  writeFileSync(
    join(userHome, ".codex", "config.toml"),
    '[mcp_servers.pluriply]\ncommand = "node"\n',
  );
  const logs = [];
  const run = (args, over = {}) =>
    runCodex(args, {
      env: { ...process.env, FAKE_CODEX_OUT: out, ...extraEnv },
      platform: "darwin",
      cwd: "/work/here",
      bin: process.execPath,
      binArgs: [FAKE],
      tmp,
      home,
      userHome,
      log: (l) => logs.push(l),
      ...over,
    });
  const calls = () =>
    existsSync(out)
      ? readFileSync(out, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  const leftovers = () =>
    readdirSync(tmp).filter((n) => n.startsWith("plp-cx-"));
  return { tmp, home, userHome, run, calls, logs, leftovers };
}

test("hasCdFlag and tuiArgs respect a working directory the user already chose", () => {
  assert.equal(hasCdFlag(["-C", "/y"]), true);
  assert.equal(hasCdFlag(["--cd", "/y"]), true);
  assert.equal(hasCdFlag(["--cd=/y"]), true);
  assert.equal(hasCdFlag(["resume", "--last"]), false);
  assert.deepEqual(
    tuiArgs({ sock: "/s/app.sock", cwd: "/w", args: ["resume", "--last"] }),
    ["--remote", "unix:///s/app.sock", "-C", "/w", "resume", "--last"],
  );
  assert.deepEqual(
    tuiArgs({ sock: "/s/app.sock", cwd: "/w", args: ["-C", "/y"] }),
    ["--remote", "unix:///s/app.sock", "-C", "/y"],
  );
});

test(
  "runs a private app server, attaches the TUI, passes the exit code, and cleans up",
  { skip: skipWin },
  async () => {
    const s = setup({ FAKE_CODEX_EXIT: "7" });
    const code = await s.run(["resume", "--last"]);
    assert.equal(code, 7);
    const [app, tui] = s.calls();
    assert.equal(app.role, "app");
    const remote = app.args[4];
    assert.deepEqual(app.args, [
      "app-server",
      "-c",
      'mcp_servers.pluriply.env_vars=["PLURIPLY_CODEX_REMOTE"]',
      "--listen",
      remote,
    ]);
    assert.match(remote, /^unix:\/\/.*\/plp-cx-[^/]+\/app\.sock$/);
    assert.equal(app.remote, remote); // 커넥터·훅이 물려받는다
    assert.equal(tui.role, "tui");
    assert.deepEqual(tui.args, [
      "--remote",
      remote,
      "-C",
      "/work/here",
      "resume",
      "--last",
    ]);
    assert.equal(tui.remote, null); // TUI 에는 넣지 않는다
    assert.deepEqual(s.leftovers(), []);
    const deadline = Date.now() + 3000;
    while (pidAlive(app.pid) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(pidAlive(app.pid), false);
  },
);

test(
  "falls back to plain codex when the app server cannot start",
  { skip: skipWin },
  async () => {
    const s = setup({ FAKE_CODEX_APP_FAIL: "1", FAKE_CODEX_EXIT: "0" });
    const code = await s.run(["-m", "x"]);
    assert.equal(code, 0);
    const tui = s.calls().find((c) => c.role === "tui");
    assert.deepEqual(tui.args, ["-m", "x"]);
    assert.match(
      s.logs.join(""),
      /pluriply: could not start the Codex app server \(see .*codex-app-server-\d+\.log\); starting plain codex without wake/,
    );
    assert.deepEqual(s.leftovers(), []);
  },
);

test("on Windows it starts plain codex with a notice", async () => {
  const s = setup({ FAKE_CODEX_EXIT: "0" });
  const code = await s.run(["x"], { platform: "win32" });
  assert.equal(code, 0);
  assert.deepEqual(
    s.calls().map((c) => [c.role, c.args]),
    [["tui", ["x"]]],
  );
  assert.equal(
    s.logs.join(""),
    "pluriply: Codex wake is not supported on Windows yet; starting plain codex\n",
  );
});

test(
  "when pluriply is not registered in Codex it starts plain codex without wake",
  { skip: skipWin },
  async () => {
    const s = setup({ FAKE_CODEX_EXIT: "0" });
    const bareUserHome = mkdtempSync(join(tmpdir(), "plp-lu-bare-"));
    const code = await s.run(["x"], { userHome: bareUserHome });
    assert.equal(code, 0);
    assert.deepEqual(
      s.calls().map((c) => [c.role, c.args]),
      [["tui", ["x"]]],
    );
    assert.equal(
      s.logs.join(""),
      "pluriply: pluriply is not registered in Codex (run `pluriply setup`); starting plain codex without wake\n",
    );
    assert.deepEqual(s.leftovers(), []);
  },
);

test(
  "removes leftovers of a launcher that died",
  { skip: skipWin },
  async () => {
    const s = setup({ FAKE_CODEX_EXIT: "0" });
    const old = join(s.tmp, "plp-cx-old");
    mkdirSync(old);
    writeFileSync(join(old, "launcher.pid"), "2147483646");
    writeFileSync(join(old, "app.pid"), "2147483645");
    await s.run([]);
    assert.deepEqual(s.leftovers(), []);
  },
);

test(
  "cleaning up a dead launcher's leftovers never kills a live process that only happens to reuse its app.pid",
  { skip: skipWin },
  async () => {
    const s = setup({ FAKE_CODEX_EXIT: "0" });
    const old = join(s.tmp, "plp-cx-notours");
    mkdirSync(old);
    writeFileSync(join(old, "launcher.pid"), "2147483646"); // 죽은 실행기
    // 우리 앱 서버가 아닌, 그저 같은 pid 파일에 적힌 살아 있는 프로세스를 흉내낸다.
    const impostor = spawn(process.execPath, [
      "-e",
      "setTimeout(() => {}, 30000)",
    ]);
    try {
      writeFileSync(join(old, "app.pid"), String(impostor.pid));
      await s.run([]);
      // 디렉터리는 지우되(고아 흔적 청소),
      assert.deepEqual(s.leftovers(), []);
      // ps 명령줄에 이 소켓 URL 이 없으니 우리 앱 서버로 보지 않는다 — 죽이지 않는다.
      assert.equal(pidAlive(impostor.pid), true);
    } finally {
      impostor.kill("SIGKILL");
    }
  },
);

test(
  "leaves alone a dir another launcher just mkdtemp'd (launcher.pid not written yet)",
  { skip: skipWin },
  async () => {
    const s = setup({ FAKE_CODEX_EXIT: "0" });
    const fresh = join(s.tmp, "plp-cx-fresh");
    mkdirSync(fresh); // launcher.pid 없음 — 다른 실행기가 mkdtemp 만 하고 아직 쓰기 전인 상태
    await s.run([]);
    assert.deepEqual(s.leftovers(), ["plp-cx-fresh"]);
  },
);

test(
  "a leftover dir whose launcher.pid can't be read (permission denied) is left alone and never fails the run",
  { skip: skipWin },
  async () => {
    const s = setup({ FAKE_CODEX_EXIT: "0" });
    const denied = join(s.tmp, "plp-cx-denied");
    mkdirSync(denied);
    const pidFile = join(denied, "launcher.pid");
    writeFileSync(pidFile, "1");
    chmodSync(pidFile, 0o000);
    try {
      const code = await s.run([]);
      assert.equal(code, 0); // 정리 실패가 실행기 시작을 막지 않는다
      assert.deepEqual(s.leftovers(), ["plp-cx-denied"]); // 건드리지 않는다
    } finally {
      chmodSync(pidFile, 0o600);
    }
  },
);

test("pluriplyRegistered detects [mcp_servers.pluriply] with or without quotes", () => {
  const dir = mkdtempSync(join(tmpdir(), "plp-lr-"));
  writeFileSync(
    join(dir, "config.toml"),
    '[mcp_servers.pluriply]\ncommand = "node"\n',
  );
  assert.equal(pluriplyRegistered({}, dir), false); // home 은 .codex 하위를 본다
  assert.equal(pluriplyRegistered({ CODEX_HOME: dir }, "/unused"), true);

  const quoted = mkdtempSync(join(tmpdir(), "plp-lr-"));
  writeFileSync(
    join(quoted, "config.toml"),
    '[mcp_servers."pluriply"]\ncommand = "node"\n',
  );
  assert.equal(pluriplyRegistered({ CODEX_HOME: quoted }, "/unused"), true);

  const envOnly = mkdtempSync(join(tmpdir(), "plp-lr-"));
  writeFileSync(
    join(envOnly, "config.toml"),
    '[mcp_servers.pluriply.env]\nFOO = "bar"\n',
  );
  assert.equal(pluriplyRegistered({ CODEX_HOME: envOnly }, "/unused"), false);

  const otherName = mkdtempSync(join(tmpdir(), "plp-lr-"));
  writeFileSync(
    join(otherName, "config.toml"),
    '[mcp_servers.other]\ncommand = "node"\n',
  );
  assert.equal(pluriplyRegistered({ CODEX_HOME: otherName }, "/unused"), false);

  const noFile = mkdtempSync(join(tmpdir(), "plp-lr-"));
  assert.equal(pluriplyRegistered({ CODEX_HOME: noFile }, "/unused"), false);
});
