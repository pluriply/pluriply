// Plan 5b(스펙 §4): `pluriply codex` — 깨울 수 있는 Codex 세션을 띄운다. 세션 전용 앱 서버를 unix
// 소켓으로 띄우고 TUI 를 --remote 로 붙인 뒤, TUI 가 끝나면 앱 서버를 내린다. 공개 코드라
// 허브·커넥터를 가져오지 않는다.
import { spawn, execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pluriplyHome } from "../shared/paths.js";
import { pidAlive } from "../shared/probe.js";

const PREFIX = "plp-cx-";
export const SOCKET_WAIT_MS = 10_000;
// launcher.pid 가 아직 없는(mkdtemp 만 되고 쓰기 전) 디렉터리를 죽은 것으로 볼 때까지 기다리는
// 시간. 너무 짧으면 방금 mkdtemp 만 하고 아직 쓰지 못한 다른 실행기를 죽은 것으로 오판한다.
export const STALE_MISSING_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TOML 표 머리는 대괄호·점 둘레 공백과 따옴표 키("…", '…')를 허용한다.
const REGISTERED_HEADER =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:pluriply|"pluriply"|'pluriply')\s*\]\s*(?:#.*)?$/m;

/**
 * Codex 설정에 pluriply MCP 서버가 등록돼 있는지(`pluriply setup` 이 넣는다). 등록돼 있지 않으면
 * 깨울 커넥터가 없다. config.toml 을 못 읽는 이유가 파일이 없어서(ENOENT)면 그냥 미등록으로
 * 본다 — 아직 `pluriply setup` 을 안 돌린 흔한 경우다. 그 밖의 이유(EACCES, 그 자리에 디렉터리가
 * 있어 EISDIR 등)는 등록 여부 자체를 알 수 없으니 `error` 로 알려 호출자가 미등록과 다른 안내를
 * 내게 한다.
 * @param {NodeJS.ProcessEnv} env @param {string} home
 * @returns {{registered: boolean, error?: {path: string, code: string}}}
 */
export function pluriplyRegistered(env, home) {
  const dir = env.CODEX_HOME || join(home, ".codex");
  const path = join(dir, "config.toml");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { registered: false };
    return {
      registered: false,
      error: { path, code: err.code ?? String(err) },
    };
  }
  return { registered: REGISTERED_HEADER.test(text) };
}

/** 사용자가 작업 폴더(-C/--cd)를 줬는지 @param {string[]} args @returns {boolean} */
export function hasCdFlag(args) {
  return args.some(
    (a) =>
      a === "-C" ||
      a === "--cd" ||
      a.startsWith("--cd=") ||
      (a.startsWith("-C") && a.length > 2),
  );
}

/**
 * pluriply MCP 서버(커넥터)의 환경을 codex 설정으로 넘기는 `-c mcp_servers.pluriply.env.KEY=…` 인자들.
 * Codex 는 MCP 서버에 부모 환경 변수를 걸러 넘긴다(codex-cli 0.155.1 실측) — env 로 주면 커넥터에 닿지
 * 않는다. 기본이 아닌 홈(PLURIPLY_HOME)과 codex 실행 파일(PLURIPLY_CODEX_BIN — 커넥터의 `codex queue` 가
 * 같은 실행 파일을 쓰게)은 있을 때만, 깨우기를 못 켠 이유(PLURIPLY_CODEX_WAKE_ERROR, Plan 6c §3.4)는
 * 주어졌을 때만 넣는다. JSON 문자열은 이 값들에 한해 TOML basic string 으로도 유효하다.
 * @param {{env: NodeJS.ProcessEnv, wakeError?: string|null}} o @returns {string[]}
 */
export function connectorEnvArgs({ env, wakeError = null }) {
  const out = [];
  const put = (key, value) =>
    out.push("-c", `mcp_servers.pluriply.env.${key}=${JSON.stringify(value)}`);
  if (env.PLURIPLY_HOME) put("PLURIPLY_HOME", env.PLURIPLY_HOME);
  if (env.PLURIPLY_CODEX_BIN) put("PLURIPLY_CODEX_BIN", env.PLURIPLY_CODEX_BIN);
  if (wakeError) put("PLURIPLY_CODEX_WAKE_ERROR", wakeError);
  return out;
}

/**
 * TUI 인자. -C 가 없으면 스레드의 작업 폴더가 앱 서버를 띄운 폴더가 되므로 현재 폴더를 준다.
 * @param {{sock: string, cwd: string, args: string[]}} o @returns {string[]}
 */
export function tuiArgs({ sock, cwd, args }) {
  return [
    "--remote",
    `unix://${sock}`,
    ...(hasCdFlag(args) ? [] : ["-C", cwd]),
    ...args,
  ];
}

/**
 * 그 pid 의 명령줄이 이 소켓을 리슨하는 codex 앱 서버인지. 명령 이름(`/app-server/`)만 보면 남의
 * 프로세스를 잘못 죽일 수 있어(우연히 이름이 같은 다른 프로그램), 이 디렉터리의 소켓 URL 문자열
 * (`unix://<dir>/app.sock`)이 명령줄에 그대로 있을 때만 우리 것으로 본다.
 * @param {number} pid @param {string} sock @returns {boolean} 확인할 수 없으면 false
 */
function isAppServer(pid, sock) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)])
      .toString()
      .includes(`unix://${sock}`);
  } catch {
    return false;
  }
}

/** @param {string} file @returns {number|null} */
function readPid(file) {
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

/**
 * launcher.pid 를 읽는다. 파일이 아직 없으면(다른 실행기가 막 mkdtemp 만 하고 그 안에 쓰기 전 —
 * 경합) `missing`, 그 외 이유로 읽기 실패(EACCES 등 — 공유 /tmp 에서 다른 사용자 소유 디렉터리)면
 * `denied` — 둘 다 건드리지 않는다(스킵). 읽는 데 성공하면 `ok`(pid 가 정수 형식이 아니면
 * pid: null 로 죽은 것으로 본다).
 * @param {string} file @returns {{status: "missing"|"denied"|"ok", pid: number|null}}
 */
function readLauncherPid(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { status: err.code === "ENOENT" ? "missing" : "denied", pid: null };
  }
  const n = Number(text.trim());
  return { status: "ok", pid: Number.isInteger(n) && n > 1 ? n : null };
}

/**
 * 이 디렉터리가 launcher.pid 없이 stale 임계값보다 오래 남아 있는지. 통계를 못 읽으면(그 사이
 * 지워졌다 등) 판단할 수 없으니 stale 이 아닌 것으로 본다 — 건드리지 않는다.
 * @param {string} dir @param {number} staleMissingMs @returns {boolean}
 */
function isStaleMissing(dir, staleMissingMs) {
  try {
    return Date.now() - statSync(dir).mtimeMs > staleMissingMs;
  } catch {
    return false;
  }
}

/**
 * 실행기가 강제 종료돼 남은 디렉터리(와 고아 앱 서버)를 치운다.
 * @param {string} tmp @param {number} staleMissingMs
 */
function cleanLeftovers(tmp, staleMissingMs = STALE_MISSING_MS) {
  let names = [];
  try {
    names = readdirSync(tmp).filter((n) => n.startsWith(PREFIX));
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(tmp, name);
    const launcher = readLauncherPid(join(dir, "launcher.pid"));
    // 권한이 없어 launcher.pid 를 읽을 수 없는 디렉터리(공유 /tmp 에서 다른 사용자 소유)는
    // 건드리지 않는다 — 건드리면 권한 오류로 rmSync 가 던져 이 실행기 자체가 시작을 못 하게 된다.
    if (launcher.status === "denied") continue;
    if (launcher.status === "missing") {
      // 막 mkdtemp 된 남의(다른 실행기의) 디렉터리일 수 있다 — 디렉터리가 stale 임계값보다
      // 최근이면 아직 launcher.pid 를 쓰는 중일 수 있으니 건드리지 않는다. 임계값보다 오래됐으면
      // mkdtemp 와 launcher.pid 쓰기 사이에서 죽은 것으로 보고 같은 정리 경로를 탄다.
      if (!isStaleMissing(dir, staleMissingMs)) continue;
      // 그 사이에 죽었다면 앱 서버는 뜬 적이 없다 — app.pid 의 프로세스가 살아 있으면 launcher.pid 만
      // 외부에서 지워진(tmp 정리 도구 등) 살아 있는 세션이니 건드리지 않는다.
      const running = readPid(join(dir, "app.pid"));
      if (running && pidAlive(running)) continue;
    } else if (launcher.pid && pidAlive(launcher.pid)) {
      continue;
    }
    const sock = join(dir, "app.sock");
    const app = readPid(join(dir, "app.pid"));
    if (app && pidAlive(app) && isAppServer(app, sock)) {
      try {
        process.kill(-app, "SIGTERM");
      } catch {
        // 이미 끝났으면 무시
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 이 디렉터리 하나를 못 지웠다고 실행기 시작을 막지 않는다
    }
  }
}

/** 자식이 끝날 때까지 기다려 종료 코드(신호면 128+번호)를 돌려준다. @param {import('node:child_process').ChildProcess} child */
function exitCodeOf(child) {
  return new Promise((resolve) => {
    child.once("error", () => resolve(127));
    child.once("exit", (code, signal) =>
      resolve(code ?? 128 + (constants.signals[signal] ?? 0)),
    );
  });
}

/** 앱 서버 프로세스 그룹을 내린다: SIGTERM, 3초 뒤에도 살아 있으면 SIGKILL. */
async function stopApp(app) {
  if (!app || app.exitCode !== null || app.signalCode !== null) return;
  const exited = new Promise((r) => app.once("exit", r));
  try {
    process.kill(-app.pid, "SIGTERM");
  } catch {
    return;
  }
  const done = await Promise.race([
    exited.then(() => true),
    sleep(3000).then(() => false),
  ]);
  if (!done) {
    try {
      process.kill(-app.pid, "SIGKILL");
    } catch {
      // 이미 끝났으면 무시
    }
  }
}

/**
 * `pluriply codex [codex 인자…]` 본체. 종료 코드를 돌려준다.
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, cwd?: string, bin?: string, binArgs?: string[], tmp?: string, home?: string, userHome?: string, socketWaitMs?: number, staleMissingMs?: number, log?: (line: string) => void}} [o]
 *   `o.cwd` 는 `-C` 인자 문구(`tuiArgs`)를 만드는 데만 쓴다 — 스폰되는 자식들의 실제 OS cwd 에는
 *   쓰지 않는다(그 값은 언제나 이 실행기 프로세스 자신의 cwd 를 물려받는다. 운영에서는
 *   `o.cwd` 의 기본값도 `process.cwd()`라 어차피 같은 디렉터리다).
 * @returns {Promise<number>}
 */
export async function runCodex(args, o = {}) {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const cwd = o.cwd ?? process.cwd();
  const bin = o.bin ?? (env.PLURIPLY_CODEX_BIN || "codex");
  const binArgs = o.binArgs ?? [];
  const home = o.home ?? pluriplyHome();
  const userHome = o.userHome ?? homedir();
  const socketWaitMs = o.socketWaitMs ?? SOCKET_WAIT_MS;
  const staleMissingMs = o.staleMissingMs ?? STALE_MISSING_MS;
  const log = o.log ?? ((line) => process.stderr.write(line));

  /**
   * 앱 서버 없이 codex 를 그대로 띄운다(Windows, 또는 앱 서버가 못 뜬 경우). TUI 는 같은 프로세스
   * 그룹이라 터미널의 신호(Ctrl-C, 터미널 닫힘)를 직접 받아 알아서 끝난다 — 실행기는 무시하고
   * TUI 가 끝나기를 기다린다. 지킬 것이 없는 경로라(앱 서버·임시 디렉터리 없음) 신호가 오면
   * 실행기가 곧장 죽어도 안전하다는 판단이 아니라, TUI 의 종료 코드를 그대로 돌려주기 위해서다.
   *
   * wakeError(깨우기를 못 켠 이유 한 줄)는 이 codex 의 pluriply 커넥터에 `-c` 로 넘긴다(Plan 6c §3.4) —
   * 커넥터가 허브에 `off` + 이유로 보고해 `pluriply status` 가 보여 준다.
   */
  const runPlainTui = async (tuiArgv, wakeError) => {
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    process.on("SIGHUP", ignore);
    try {
      const tui = spawn(
        bin,
        [...binArgs, ...connectorEnvArgs({ env, wakeError }), ...tuiArgv],
        {
          stdio: "inherit",
          env,
        },
      );
      return await exitCodeOf(tui);
    } finally {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
      process.off("SIGHUP", ignore);
    }
  };

  if (platform === "win32") {
    const why = "Codex wake is not supported on Windows yet";
    log(`pluriply: ${why}; starting plain codex\n`);
    return runPlainTui(args, why);
  }

  const reg = pluriplyRegistered(env, userHome);
  if (reg.error) {
    const why = `could not read ${reg.error.path} (${reg.error.code})`;
    log(`pluriply: ${why}; starting plain codex\n`);
    return runPlainTui(args, why);
  }
  if (!reg.registered) {
    const why = "pluriply is not registered in Codex (run `pluriply setup`)";
    log(`pluriply: ${why}; starting plain codex without wake\n`);
    return runPlainTui(args, why);
  }

  // 소켓 디렉터리가 심볼릭 링크 경로면 앱 서버가 거절한다(/tmp → /private/tmp) — 실경로를 쓴다
  const tmp = o.tmp ?? realpathSync(tmpdir());
  cleanLeftovers(tmp, staleMissingMs);
  const dir = mkdtempSync(join(tmp, PREFIX));
  const sock = join(dir, "app.sock");
  writeFileSync(join(dir, "launcher.pid"), String(process.pid));
  const logDir = join(home, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `codex-app-server-${process.pid}.log`);
  const fd = openSync(logPath, "a");

  // 스펙 §4-8: 실행기만 받은 신호는 TUI 로 넘기지 않는다(포워딩 없음) — 여기서는 실행기가 신호로
  // 그냥 죽어 정리(cleanup)를 건너뛰지 않게만 막는다. 앱 서버를 띄우기 직전부터 걸어 두고, 정리가
  // 끝난 뒤에야 뗀다(중간에 떼면 그 사이 온 신호로 죽어 앱 서버가 고아로 남는다). TUI 가 아직
  // 뜨기 전(소켓 대기 중)에 신호가 오면 여기서 직접 정리하고 128+번호로 끝낸다. TUI 가 뜨고
  // 나면(같은 프로세스 그룹이라 터미널 신호를 TUI 가 직접 받아 스스로 끝난다) 실행기는 그냥
  // 죽지 않고 TUI 가 끝나기를 기다리기만 한다.
  let app;
  let tuiStarted = false;
  let handledSignal = false;
  const cleanupOnce = async () => {
    await stopApp(app);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 정리 실패로 종료를 막지 않는다
    }
  };
  const offSignals = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  };
  const onSignal = (sig) => {
    if (tuiStarted || handledSignal) return; // TUI 가 직접 받아 처리하거나 이미 정리 중이다
    handledSignal = true;
    cleanupOnce().finally(() => {
      offSignals();
      process.exit(128 + (constants.signals[sig] ?? 0));
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  // detached: 별도 프로세스 그룹 — TUI 에서 누른 Ctrl-C 가 앱 서버에 닿지 않게. cwd 는 지정하지
  // 않는다(실행기 자신의 실제 cwd 를 그대로 물려받는다 — 운영에서는 어차피 같은 값).
  // 소켓 주소는 앱 서버 env 가 아니라 `-c` 로 pluriply MCP 서버에만 준다 — env 로 주면 셸·자식
  // `codex exec` 까지 물려받아 제 스레드를 부모 소켓으로 깨우려다 실패한다(codex-cli 0.155.1
  // 실측: `env.KEY` 는 사용자 설정의 [mcp_servers.pluriply] 에 합쳐지고 부모 env 는 걸러진다).
  // JSON 문자열은 mkdtemp 소켓 경로에 한해 TOML basic string 으로도 유효하다(DEL·짝 없는
  // 서로게이트는 아니지만 여기서는 나올 수 없다). 바깥 `pluriply codex` 에서 물려받은 값은 지운다.
  const appEnv = { ...env };
  delete appEnv.PLURIPLY_CODEX_REMOTE;
  app = spawn(
    bin,
    [
      ...binArgs,
      "app-server",
      "-c",
      `mcp_servers.pluriply.env.PLURIPLY_CODEX_REMOTE=${JSON.stringify(`unix://${sock}`)}`,
      // 기본이 아닌 홈·codex 실행 파일도 같은 이유로 설정으로 넘긴다(걸러지면 커넥터가 ~/.pluriply
      // 허브에 붙고, `codex queue` 가 PATH 의 codex 를 찾는다)
      ...connectorEnvArgs({ env }),
      "--listen",
      `unix://${sock}`,
    ],
    {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: appEnv,
    },
  );
  closeSync(fd);
  writeFileSync(join(dir, "app.pid"), String(app.pid ?? ""));
  let appExited = false;
  app.once("exit", () => {
    appExited = true;
  });
  app.once("error", () => {
    appExited = true;
  });

  const deadline = Date.now() + socketWaitMs;
  while (
    !existsSync(sock) &&
    !appExited &&
    !handledSignal &&
    Date.now() < deadline
  )
    await sleep(100);
  if (handledSignal) return await new Promise(() => {}); // onSignal 이 정리하고 곧 종료한다
  if (!existsSync(sock) || appExited) {
    const why = `could not start the Codex app server (see ${logPath})`;
    log(`pluriply: ${why}; starting plain codex without wake\n`);
    await stopApp(app);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 정리 실패를 무시한다
    }
    offSignals();
    return runPlainTui(args, why);
  }

  tuiStarted = true;
  try {
    const tui = spawn(bin, [...binArgs, ...tuiArgs({ sock, cwd, args })], {
      stdio: "inherit",
      env,
    });
    return await exitCodeOf(tui);
  } finally {
    await stopApp(app);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 정리 실패를 무시한다
    }
    offSignals();
  }
}
