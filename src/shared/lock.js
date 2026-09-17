import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * `<home>/hub.json` 락파일. 없거나 손상이면(pid·port 가 정수가 아니면 포함) null.
 * 허브(lifecycle.js)와 setup 이 같이 읽는다 — setup 은 허브 코드 없이도 로드돼야 한다(Plan 4e).
 * @param {string} home @returns {object|null}
 */
export function readLock(home) {
  const lockPath = join(home, "hub.json");
  if (!existsSync(lockPath)) return null;
  try {
    const doc = JSON.parse(readFileSync(lockPath, "utf8"));
    if (!Number.isInteger(doc?.pid) || !Number.isInteger(doc?.port))
      return null;
    // Plan 4f: 연결 토큰. 구버전 허브의 락에는 없고, 문자열이 아니면 없는 것으로 본다.
    const { token, ...rest } = doc;
    return typeof token === "string" && token.length > 0
      ? { ...rest, token }
      : rest;
  } catch {
    return null;
  }
}
