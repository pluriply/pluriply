#!/usr/bin/env node
/**
 * `npm test` 실행기. 셸 glob(`'test/**\/*.test.js'`)은 Windows 셸이 작은따옴표를 문자로 넘기고
 * Node 20 의 --test 는 glob 을 모르며, `node --test test/` 는 test/fixtures/*.js 까지 실행한다.
 * 그래서 *.test.js 만 직접 모아 node --test 에 파일 목록으로 넘긴다. 인자로 하위 경로를 주면
 * 그 아래만 돈다: `npm test -- test/setup`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** @param {string} dir @returns {string[]} 절대 경로, 정렬 */
export function collectTestFiles(dir) {
  const out = [];
  const walk = (p) => {
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p).sort()) walk(join(p, name));
    } else if (p.endsWith(".test.js")) out.push(p);
  };
  walk(dir);
  return out;
}

/**
 * `ps -ax -o pid=,command=` 출력에서 허브 프로세스(`pluriply.js hub start`)만 고른다.
 * @param {string} out @returns {Map<number, string>} pid → 명령줄
 */
export function parseHubProcesses(out) {
  const map = new Map();
  for (const line of String(out).split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m && /[\\/]pluriply\.js hub start\b/.test(m[2]))
      map.set(Number(m[1]), m[2]);
  }
  return map;
}

/**
 * 실행 뒤에 새로 생긴 허브 중 테스트가 남긴 것으로 보이는 것. 실행 전부터 있던 허브(사용자의 실사용
 * 허브)는 제외하고, PLURIPLY_HOME 을 읽을 수 있으면 임시 폴더 아래 홈인 것만 남긴다(그 사이 사용자가
 * 실사용 허브를 다시 띄운 경우를 오탐하지 않게). 홈을 못 읽으면 후보로 남긴다(경고일 뿐이다).
 * @param {Map<number, string>} before @param {Map<number, string>} after
 * @param {(pid: number) => string|null} homeOf @param {string[]} tempRoots
 * @returns {Array<{pid: number, command: string, home: string|null}>}
 */
export function leakedHubs(before, after, homeOf, tempRoots) {
  const out = [];
  for (const [pid, command] of after) {
    if (before.has(pid)) continue;
    const home = homeOf(pid);
    if (home && !tempRoots.some((r) => home === r || home.startsWith(`${r}/`)))
      continue;
    out.push({ pid, command, home });
  }
  return out;
}

/** @returns {Map<number, string>|null} 허브 프로세스 목록(Windows·ps 실패면 null — 검사를 건너뛴다) */
function listHubs() {
  if (process.platform === "win32") return null;
  const r = spawnSync("ps", ["-ax", "-o", "pid=,command="], {
    encoding: "utf8",
  });
  return r.status === 0 ? parseHubProcesses(r.stdout) : null;
}

/** @param {number} pid @returns {string|null} 그 프로세스의 PLURIPLY_HOME(읽을 수 있을 때만) */
function homeOf(pid) {
  try {
    if (process.platform === "linux") {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      const hit = env.find((e) => e.startsWith("PLURIPLY_HOME="));
      return hit ? hit.slice("PLURIPLY_HOME=".length) : null;
    }
    // macOS: ps -E 는 명령줄 뒤에 환경을 붙인다(공백 없는 임시 경로만 정확히 읽힌다)
    const r = spawnSync(
      "ps",
      ["-E", "-ww", "-o", "command=", "-p", String(pid)],
      {
        encoding: "utf8",
      },
    );
    return r.stdout.match(/(?:^|\s)PLURIPLY_HOME=(\S+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** 임시 폴더의 여러 표기(macOS 는 /var → /private/var 링크) */
function tempRoots() {
  const t = tmpdir();
  const roots = new Set([t, "/tmp", "/private/tmp"]);
  if (t.startsWith("/var/")) roots.add(`/private${t}`);
  if (t.startsWith("/private/var/")) roots.add(t.slice("/private".length));
  return [...roots];
}

/**
 * 테스트가 남긴 분리된 허브를 알린다(Plan 6c 최종 리뷰). 경고만 한다 — 아무것도 죽이지 않고 실행 결과도
 * 바꾸지 않는다. 막 멈추는 중인 허브를 오탐하지 않게 1초 뒤 한 번 더 확인한다.
 * @param {Map<number, string>|null} before
 */
function warnLeakedHubs(before) {
  if (!before) return;
  const check = () => {
    const after = listHubs();
    return after ? leakedHubs(before, after, homeOf, tempRoots()) : [];
  };
  if (check().length === 0) return;
  spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"]);
  for (const h of check())
    console.error(
      `run-tests: warning: a hub started during the tests is still running: pid ${h.pid}, PLURIPLY_HOME=${h.home ?? "?"}, ${h.command}`,
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const targets = process.argv.slice(2);
  // 존재하지 않는 하위 경로를 주면 readdirSync/statSync 가 raw ENOENT 스택을 던진다.
  // 사람이 읽을 메시지로 바꿔 exit 1. (경로 수가 많아지면 명령줄 인자로 나열하는
  // 이 방식은 Windows 의 명령줄 길이 제한(~32KB)에 걸릴 수 있어 그때는 매니페스트
  // 파일이나 디렉터리 단위 실행으로 바꿔야 한다 — 대략 파일 300개 안팎이 한계.)
  for (const t of targets) {
    const p = resolve(ROOT, t);
    if (!existsSync(p)) {
      console.error(`no such test path: ${p}`);
      process.exit(1);
    }
  }
  const files = (targets.length ? targets : ["test"]).flatMap((t) =>
    collectTestFiles(resolve(ROOT, t)),
  );
  if (files.length === 0) {
    console.error(`no *.test.js under ${targets.join(", ") || "test"}`);
    process.exit(1);
  }
  const hubsBefore = listHubs();
  const r = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
    cwd: ROOT,
  });
  warnLeakedHubs(hubsBefore);
  process.exit(r.status ?? 1);
}
