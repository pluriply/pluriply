import {
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// 한 번만 보여 줄 안내의 기록 `<home>/hints.json` = {"view": "<ISO>"}(view 설계 §6.5).

/** setup·status 끝에 붙는 한 줄 안내 */
export const VIEW_HINT_LINE = "See it on screen: npx pluriply view";

const hintsPath = (home) => join(home, "hints.json");

/** 없거나 손상이면 빈 객체 */
function readHints(home) {
  try {
    const doc = JSON.parse(readFileSync(hintsPath(home), "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

/** @param {string} home @param {string} name @returns {boolean} */
export function hasHint(home, name) {
  return Object.hasOwn(readHints(home), name);
}

/**
 * 안내를 보여 줬다고 기록한다. 기존 내용은 보존하고 tmp+rename 으로 쓴다(손상 파일은 덮는다).
 * @param {string} home @param {string} name @param {Date} [now]
 */
export function markHint(home, name, now = new Date()) {
  const doc = { ...readHints(home), [name]: now.toISOString() };
  mkdirSync(home, { recursive: true });
  const file = hintsPath(home);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(doc));
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
