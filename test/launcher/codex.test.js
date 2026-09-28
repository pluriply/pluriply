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
  utimesSync,
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
  return { tmp, home, userHome, out, run, calls, logs, leftovers };
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
      `mcp_servers.pluriply.env.PLURIPLY_CODEX_REMOTE=${JSON.stringify(remote)}`,
      "--listen",
      remote,
    ]);
    assert.match(remote, /^unix:\/\/.*\/plp-cx-[^/]+\/app\.sock$/);
    // 앱 서버 프로세스 자신의 env 에는 넣지 않는다 — `-c ...env.KEY=` 로만 MCP 서버 항목에
    // 병합돼 들어가고, 앱 서버 밑의 다른 자식(모델이 띄우는 codex exec 등)에는 새지 않는다.
    assert.equal(app.remote, null);
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
  "passes a non-default PLURIPLY_HOME to the pluriply connector through -c env",
  { skip: skipWin },
  async () => {
    // Codex 는 MCP 서버에 부모 환경 변수를 걸러 넘긴다 — 홈을 설정으로 직접 주지 않으면 커넥터가
    // 기본 홈(~/.pluriply)의 허브에 붙는다.
    const s = setup({
      FAKE_CODEX_EXIT: "0",
      PLURIPLY_HOME: "/tmp/plp e2e/home",
    });
    await s.run(["x"]);
    const app = s.calls().find((c) => c.role === "app");
    assert.ok(
      app.args.includes(
        'mcp_servers.pluriply.env.PLURIPLY_HOME="/tmp/plp e2e/home"',
      ),
    );
    const plain = setup({ FAKE_CODEX_EXIT: "0" });
    const env = { ...process.env };
    delete env.PLURIPLY_HOME;
    await plain.run(["x"], { env: { ...env, FAKE_CODEX_OUT: plain.out } });
    const app2 = plain.calls().find((c) => c.role === "app");
    assert.ok(
      !app2.args.some((a) =>
        a.startsWith("mcp_servers.pluriply.env.PLURIPLY_HOME"),
      ),
    );
  },
);

test(
  "strips a PLURIPLY_CODEX_REMOTE the launcher itself inherited before starting the app server",
  { skip: skipWin },
  async () => {
    const s = setup({
      FAKE_CODEX_EXIT: "0",
      PLURIPLY_CODEX_REMOTE: "unix:///old/session/app.sock",
    });
    await s.run(["x"]);
    const app = s.calls().find((c) => c.role === "app");
    assert.equal(app.remote, null); // 이전 세션의 소켓 주소가 새 앱 서버로 새지 않는다
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
  "when Codex's config.toml can't be read for a reason other than missing, it starts plain codex with a distinct notice",
  { skip: skipWin },
  async () => {
    const s = setup({ FAKE_CODEX_EXIT: "0" });
    const brokenUserHome = mkdtempSync(join(tmpdir(), "plp-lu-broken-"));
    mkdirSync(join(brokenUserHome, ".codex", "config.toml"), {
      recursive: true,
    }); // config.toml 자리에 디렉터리 — EISDIR
    const code = await s.run(["x"], { userHome: brokenUserHome });
    assert.equal(code, 0);
    assert.deepEqual(
      s.calls().map((c) => [c.role, c.args]),
      [["tui", ["x"]]],
    );
    assert.match(
      s.logs.join(""),
      /^pluriply: could not read .*config\.toml \(EISDIR\); starting plain codex\n$/,
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
  "removes a leftover dir whose launcher.pid was never written, once it's older than the stale threshold",
  { skip: skipWin },
  async () => {
    const s = setup({ FAKE_CODEX_EXIT: "0" });
    const stale = join(s.tmp, "plp-cx-stale");
    mkdirSync(stale); // launcher.pid 없음 — mkdtemp 만 하고 죽은 실행기를 흉내낸다
    const old = new Date(Date.now() - 1000);
    utimesSync(stale, old, old);
    await s.run([], { staleMissingMs: 100 });
    assert.deepEqual(s.leftovers(), []);
  },
);

test(
  "a stale dir without launcher.pid is left alone while its app.pid process is alive",
  { skip: skipWin },
  async () => {
    const s = setup({ FAKE_CODEX_EXIT: "0" });
    const dir = join(s.tmp, "plp-cx-live");
    mkdirSync(dir); // launcher.pid 만 외부에서 지워진 살아 있는 세션을 흉내낸다
    writeFileSync(join(dir, "app.pid"), String(process.pid));
    const old = new Date(Date.now() - 1000);
    utimesSync(dir, old, old);
    await s.run([], { staleMissingMs: 100 });
    assert.deepEqual(s.leftovers(), ["plp-cx-live"]);
  },
);

test(
  "a leftover dir whose launcher.pid can't be read (permission denied) is left alone and never fails the run",
  { skip: skipWin || (process.getuid?.() === 0 && "root ignores chmod 000") },
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

test("pluriplyRegistered detects [mcp_servers.pluriply] with or without quotes, and a trailing comment", () => {
  const dir = mkdtempSync(join(tmpdir(), "plp-lr-"));
  writeFileSync(
    join(dir, "config.toml"),
    '[mcp_servers.pluriply]\ncommand = "node"\n',
  );
  assert.deepEqual(pluriplyRegistered({}, dir), { registered: false }); // home 은 .codex 하위를 본다
  assert.deepEqual(pluriplyRegistered({ CODEX_HOME: dir }, "/unused"), {
    registered: true,
  });

  const quoted = mkdtempSync(join(tmpdir(), "plp-lr-"));
  writeFileSync(
    join(quoted, "config.toml"),
    '[mcp_servers."pluriply"]\ncommand = "node"\n',
  );
  assert.deepEqual(pluriplyRegistered({ CODEX_HOME: quoted }, "/unused"), {
    registered: true,
  });

  const commented = mkdtempSync(join(tmpdir(), "plp-lr-"));
  writeFileSync(
    join(commented, "config.toml"),
    '[mcp_servers.pluriply]  # managed by pluriply setup\ncommand = "node"\n',
  );
  assert.deepEqual(pluriplyRegistered({ CODEX_HOME: commented }, "/unused"), {
    registered: true,
  });

  // TOML 은 표 머리의 대괄호·점 둘레 공백과 리터럴 문자열 키를 허용한다
  for (const header of [
    "[ mcp_servers.pluriply ]",
    "[mcp_servers.'pluriply']",
    '[ mcp_servers . "pluriply" ]',
  ]) {
    const spaced = mkdtempSync(join(tmpdir(), "plp-lr-"));
    writeFileSync(join(spaced, "config.toml"), `${header}\ncommand = "node"\n`);
    assert.deepEqual(
      pluriplyRegistered({ CODEX_HOME: spaced }, "/unused"),
      { registered: true },
      header,
    );
  }

  const envOnly = mkdtempSync(join(tmpdir(), "plp-lr-"));
  writeFileSync(
    join(envOnly, "config.toml"),
    '[mcp_servers.pluriply.env]\nFOO = "bar"\n',
  );
  assert.deepEqual(pluriplyRegistered({ CODEX_HOME: envOnly }, "/unused"), {
    registered: false,
  });

  const otherName = mkdtempSync(join(tmpdir(), "plp-lr-"));
  writeFileSync(
    join(otherName, "config.toml"),
    '[mcp_servers.other]\ncommand = "node"\n',
  );
  assert.deepEqual(pluriplyRegistered({ CODEX_HOME: otherName }, "/unused"), {
    registered: false,
  });

  const noFile = mkdtempSync(join(tmpdir(), "plp-lr-"));
  assert.deepEqual(pluriplyRegistered({ CODEX_HOME: noFile }, "/unused"), {
    registered: false,
  });
});

test("pluriplyRegistered reports a read error distinct from not-registered when config.toml can't be read", () => {
  const dir = mkdtempSync(join(tmpdir(), "plp-lr-err-"));
  // config.toml 자리에 디렉터리를 둬 EISDIR 을 유도한다 — chmod 000 은 root 로 실행되는 CI 에서는
  // 무시되므로 대신 이 방법으로 "ENOENT 가 아닌" 읽기 실패를 만든다.
  mkdirSync(join(dir, "config.toml"));
  const result = pluriplyRegistered({ CODEX_HOME: dir }, "/unused");
  assert.equal(result.registered, false);
  assert.equal(result.error.code, "EISDIR");
  assert.equal(result.error.path, join(dir, "config.toml"));
});
