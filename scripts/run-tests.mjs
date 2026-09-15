#!/usr/bin/env node
/**
 * `npm test` 실행기. 셸 glob(`'test/**\/*.test.js'`)은 Windows 셸이 작은따옴표를 문자로 넘기고
 * Node 20 의 --test 는 glob 을 모르며, `node --test test/` 는 test/fixtures/*.js 까지 실행한다.
 * 그래서 *.test.js 만 직접 모아 node --test 에 파일 목록으로 넘긴다. 인자로 하위 경로를 주면
 * 그 아래만 돈다: `npm test -- test/setup`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
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
  const r = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
    cwd: ROOT,
  });
  process.exit(r.status ?? 1);
}
