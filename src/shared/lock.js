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
    return Number.isInteger(doc?.pid) && Number.isInteger(doc?.port)
      ? doc
      : null;
  } catch {
    return null;
  }
}
