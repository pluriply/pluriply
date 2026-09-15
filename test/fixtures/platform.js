import { symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const IS_WIN = process.platform === "win32";

/** 비교용: 경로 구분자를 `/` 로. 기대값을 `/` 로 적은 테스트가 `join`·`resolve` 결과와 비교할 때 쓴다. */
export const posixLike = (p) => p.replaceAll("\\", "/");

/**
 * 링크를 실제로 만들어 본다. Windows 에서 개발자 모드·관리자가 아니면 EPERM 이라 그때만 skip.
 * (GitHub 의 windows-latest 러너는 관리자라 링크 테스트가 실제로 돈다.)
 * @returns {boolean} true 면 진행, false 면 이미 skip 했으니 테스트에서 return 할 것
 */
export function skipUnlessSymlinks(t, dir) {
  const target = join(dir, ".symlink-probe-target");
  const link = join(dir, ".symlink-probe");
  try {
    writeFileSync(target, "");
    symlinkSync(target, link);
    return true;
  } catch (err) {
    if (err.code === "EPERM") {
      t.skip("symlinks need Developer Mode or admin rights on this Windows");
      return false;
    }
    throw err;
  } finally {
    rmSync(link, { force: true });
    rmSync(target, { force: true });
  }
}

/** OS 가 물리적으로 못 하는 검증(POSIX 파일 모드)에만. @returns {boolean} true 면 skip 됐으니 return */
export function skipOnWindows(t, reason) {
  if (!IS_WIN) return false;
  t.skip(reason);
  return true;
}
