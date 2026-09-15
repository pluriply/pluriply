import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// 저자 정보는 env 로 주고, 사용자 전역·시스템 git 설정(훅 경로, autocrlf, LFS 필터,
// gpg 서명 등)과는 격리한다 — src/hub/git-hardened.js 와 같은 방식. 2026-09-14 Windows
// 실기기에서 전체 스위트 동시 실행 중 첫 commit 이 출력 없이 exit 1 한 뒤 추가.
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** @param {string} dir @param {...string} args @returns {string} stdout */
export function gitIn(dir, ...args) {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, ...AUTHOR_ENV },
  });
}

/**
 * 커밋 2개(a.js, b.js)와 미커밋 변경(b.js)이 있는 임시 저장소.
 * HEAD~1 → HEAD 는 a.js 에 "two" 추가, 워킹트리는 b.js 에 "uncommitted" 추가.
 * @returns {string} 저장소 경로
 */
export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "plp-git-"));
  gitIn(dir, "init", "-q");
  writeFileSync(join(dir, "a.js"), "one\n");
  writeFileSync(join(dir, "b.js"), "b\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "init");
  writeFileSync(join(dir, "a.js"), "one\ntwo\n");
  gitIn(dir, "commit", "-q", "-am", "second");
  writeFileSync(join(dir, "b.js"), "b\nuncommitted\n");
  return dir;
}
