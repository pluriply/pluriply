import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { openSync, closeSync, rmSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { pluriplyHome } from "./paths.js";
import { PACKAGE_VERSION } from "./version.js";
import { readViewLock, removeViewLockIf, KEY_HEADER } from "./view-lock.js";
import { markHint, VIEW_HINT_LINE } from "./hints.js";

// 화면 서버를 띄우거나 재사용하고 브라우저를 여는 런처(view 설계 §6.3). CLI·커넥터 공용이라
// 허브 코드를 가져오지 않는다(공개 미러에는 src/hub 가 없다).

export { VIEW_HINT_LINE };

const BIN_PATH = fileURLToPath(
  new URL("../../bin/pluriply.js", import.meta.url),
);
const POLL_MS = 100;
/** 다른 런처가 띄우는 중이라고 믿는 spawn 잠금의 나이 */
const SPAWN_LOCK_FRESH_MS = 10_000;

/** probe.js 는 ws 를 가져와 공개 미러의 setup 로드를 깨므로 여기서 따로 둔다 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** @param {{port: number, key: string}} lock @returns {string} */
export function viewUrl(lock) {
  return `http://127.0.0.1:${lock.port}/#key=${lock.key}`;
}

/**
 * 잠금의 키로 /health 를 부른다. 응답이 없거나 올바르지 않으면 null.
 * @param {{port: number, key: string}} lock @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, version: string, pid: number}|null>}
 */
export function viewHealth(lock, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: lock.port,
        path: "/health",
        headers: { [KEY_HEADER]: lock.key },
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const doc = JSON.parse(body);
            resolve(res.statusCode === 200 && doc?.ok === true ? doc : null);
          } catch {
            resolve(null);
          }
        });
        res.on("error", () => resolve(null));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

/**
 * `pluriply view --serve` 분리 프로세스의 spawn 옵션. 작업 폴더는 홈 — 부른 쪽(사용자 프로젝트)의
 * 폴더를 물려받으면 Windows 에서 서버가 사는 30분 동안 그 폴더를 지우거나 옮길 수 없다.
 * @param {string} home
 */
export function serveSpawnOptions(home) {
  return {
    cwd: home,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, PLURIPLY_HOME: home },
  };
}

/** 분리 프로세스로 `pluriply view --serve` 를 띄운다. @param {string} home */
function defaultSpawnServe(home) {
  mkdirSync(home, { recursive: true }); // cwd 로 쓰므로 있어야 한다
  const child = spawn(
    process.execPath,
    [BIN_PATH, "view", "--serve"],
    serveSpawnOptions(home),
  );
  child.on("error", () => {}); // 못 띄우면 ensureView 의 기한이 잡는다
  child.unref();
}

/** 기본 브라우저 열기. 못 열면 false(동기 예외·error 이벤트 모두). @param {string} url @returns {Promise<boolean>} */
function defaultOpenBrowser(url) {
  return new Promise((resolve) => {
    try {
      const [cmd, args] =
        process.platform === "darwin"
          ? ["open", [url]]
          : process.platform === "win32"
            ? ["cmd", ["/c", "start", '""', url]]
            : ["xdg-open", [url]];
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** 잠금이 있고 그 키로 건강하며 버전이 맞으면 그 잠금. */
async function readyLock(home, version, budgetMs = 1000) {
  const lock = readViewLock(home);
  if (!lock) return null;
  const h = await viewHealth(lock, Math.max(50, Math.min(1000, budgetMs)));
  return h && h.version === version ? lock : null;
}

/**
 * 화면 서버를 재사용하거나(같은 버전) 새로 띄운다(없거나 다른 버전). 동시에 부르면
 * `<home>/view-spawn.lock` 으로 spawn 을 하나로 줄인다.
 * @param {{home?: string, open?: boolean, version?: string, spawnServe?: (home: string) => void,
 *   openBrowser?: (url: string) => boolean|Promise<boolean>, stop?: (home: string) => Promise<string>,
 *   timeoutMs?: number}} [opts]
 * @returns {Promise<{url: string, opened: boolean, reused: boolean}>}
 */
export async function ensureView({
  home = pluriplyHome(),
  open = true,
  version = PACKAGE_VERSION,
  spawnServe = defaultSpawnServe,
  openBrowser = defaultOpenBrowser,
  stop = (h) => stopView({ home: h }),
  timeoutMs = 5000,
} = {}) {
  let lock = await readyLock(home, version, timeoutMs);
  let reused = true;
  if (!lock) {
    const old = readViewLock(home);
    const oldHealth = old ? await viewHealth(old) : null;
    if (oldHealth && oldHealth.version !== version) {
      // 건강하지만 버전이 다른 서버 — 멈추고 새로 띄운다
      const r = await stop(home);
      if (r === "timeout" || r === "unresponsive")
        throw new Error("could not stop the previous pluriply view server");
    }
    const deadline = Date.now() + timeoutMs;
    const spawnLock = join(home, "view-spawn.lock");
    let owned = false;
    try {
      mkdirSync(home, { recursive: true });
      for (;;) {
        try {
          closeSync(openSync(spawnLock, "wx"));
          owned = true;
          break;
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
        }
        let age = 0;
        try {
          age = Date.now() - statSync(spawnLock).mtimeMs;
        } catch {
          continue; // 그새 지워졌다 — 다시 잡아 본다
        }
        if (age >= SPAWN_LOCK_FRESH_MS) {
          rmSync(spawnLock, { force: true });
          continue;
        }
        break; // 남이 띄우는 중 — 기다리기만 한다
      }
      // 잠금을 잡는 사이 남이 끝냈을 수 있다
      lock = await readyLock(home, version, deadline - Date.now());
      if (!lock && owned) {
        spawnServe(home);
        reused = false;
      }
      while (!lock) {
        if (Date.now() >= deadline)
          throw new Error(
            `pluriply view did not start within ${Math.round(timeoutMs / 1000)}s`,
          );
        await sleep(POLL_MS);
        lock = await readyLock(home, version, deadline - Date.now());
      }
    } finally {
      if (owned) rmSync(spawnLock, { force: true });
    }
  }
  const url = viewUrl(lock);
  let opened = false;
  if (open) {
    try {
      opened = (await openBrowser(url)) === true;
    } catch {
      opened = false;
    }
  }
  try {
    markHint(home, "view");
  } catch {
    // 힌트 기록 실패는 열기를 막지 않는다
  }
  return { url, opened, reused };
}

/** 포트가 연결을 받는지(거부하면 서버는 없다) */
function portAccepts(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * 화면 서버를 멈춘다(허브 stop 과 같은 신원 규칙). 건강 응답의 pid 가 잠금 pid 와 같을 때만
 * SIGTERM. pid 가 다르거나 포트가 거부하면 낡은 잠금으로 보고 지우기만 한다. 응답은 없는데
 * 포트가 받으면 기한까지 다시 묻고, 끝내 답이 없으면 건드리지 않고 "unresponsive".
 * @param {{home: string, timeoutMs?: number}} opts
 * @returns {Promise<"stopped"|"not-running"|"unresponsive"|"timeout">}
 */
export async function stopView({ home, timeoutMs = 5000 }) {
  const lock = readViewLock(home);
  if (!lock) return "not-running";
  const deadline = Date.now() + timeoutMs;
  const left = (floor = 0) => Math.max(floor, deadline - Date.now());
  let h = await viewHealth(lock, Math.min(1000, timeoutMs));
  let busy = !h && (await portAccepts(lock.port, Math.min(1000, left(100))));
  while (!h && busy && left() > 0) {
    await sleep(Math.min(200, left()));
    h = await viewHealth(lock, Math.min(1000, left(100)));
    if (!h) busy = await portAccepts(lock.port, Math.min(1000, left(100)));
  }
  if (!h && busy && pidAlive(lock.pid)) return "unresponsive";
  if (!h || h.pid !== lock.pid) {
    removeViewLockIf(home, lock);
    return "not-running";
  }
  try {
    process.kill(lock.pid, "SIGTERM");
  } catch {
    removeViewLockIf(home, lock);
    return "stopped";
  }
  const killDeadline = Date.now() + timeoutMs;
  while (Date.now() < killDeadline) {
    const cur = readViewLock(home);
    if (!cur || cur.pid !== lock.pid || cur.port !== lock.port)
      return "stopped";
    if (!pidAlive(lock.pid)) {
      // 정리 없이 죽었다(Windows 의 SIGTERM) — 잠금이 그대로면 지운다
      removeViewLockIf(home, { pid: lock.pid, port: lock.port });
      return "stopped";
    }
    await sleep(POLL_MS);
  }
  return "timeout";
}
