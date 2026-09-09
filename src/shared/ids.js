import { randomBytes } from "node:crypto";

// 혼동되기 쉬운 문자(i, l, o, 0, 1) 제외
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** @param {number} [len] @returns {string} */
export function shortId(len = 8) {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** @returns {string} 사용자에게 보여줄 채널 코드 */
export function channelCode() {
  return `plp-${shortId(4)}-${shortId(4)}`;
}

/** @returns {string} */
export function taskId() {
  return `task_${shortId(10)}`;
}

/** @returns {string} */
export function entryId() {
  return `ctx_${shortId(10)}`;
}
