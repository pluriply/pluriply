import {
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// 화면 서버의 잠금 파일 `<home>/view.json` = {pid, port, key, startedAt, version}(view 설계 §6.1).
// 화면 서버와 런처(CLI·커넥터)가 같이 쓴다 — 허브 코드 없이 로드돼야 한다.

/** 화면 서버 요청의 키 헤더 */
export const KEY_HEADER = "x-pluriply-view-key";

const lockPath = (home) => join(home, "view.json");

/**
 * 없거나 손상이면(pid·port 가 정수가 아니거나 key 가 문자열이 아니면 포함) null.
 * @param {string} home
 * @returns {{pid: number, port: number, key: string, startedAt: string, version: string}|null}
 */
export function readViewLock(home) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(lockPath(home), "utf8"));
  } catch {
    return null;
  }
  if (
    !Number.isInteger(doc?.pid) ||
    !Number.isInteger(doc?.port) ||
    typeof doc?.key !== "string" ||
    !doc.key
  )
    return null;
  return {
    pid: doc.pid,
    port: doc.port,
    key: doc.key,
    startedAt: doc.startedAt,
    version: doc.version,
  };
}

/**
 * tmp+rename 으로 원자적으로 쓴다. 권한 0600(키가 들어 있다 — Windows ACL 은 hub.json 과 같은 이월).
 * @param {string} home @param {object} doc
 */
export function writeViewLock(home, doc) {
  mkdirSync(home, { recursive: true });
  const file = lockPath(home);
  // 한 프로세스에 서버가 여럿일 수 있어(테스트) pid 만으로는 tmp 이름이 겹칠 수 있다
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * 잠금의 pid 와 port 가 둘 다 같을 때만 지운다(남이 새로 쓴 잠금을 지우지 않는다).
 * @param {string} home @param {{pid: number, port: number}} owner @returns {boolean} 지웠으면 true
 */
export function removeViewLockIf(home, { pid, port }) {
  const cur = readViewLock(home);
  if (!cur || cur.pid !== pid || cur.port !== port) return false;
  try {
    rmSync(lockPath(home));
    return true;
  } catch {
    return false;
  }
}
