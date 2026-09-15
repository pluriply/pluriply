import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** ids.js의 shortId 알파벳(i, l, o, 0, 1 제외)과 같은 문자 집합 */
const INSTANCE_RE = /^[^#/\s]+#[a-hj-km-np-z2-9]{4}$/;

/** @param {unknown} name @returns {boolean} 도구 이름: 비어 있지 않고 '#', '/', 공백이 없다 */
export function isValidAgentName(name) {
  return typeof name === "string" && name.length > 0 && !/[#/\s]/.test(name);
}

/**
 * 실행 환경으로 도구 이름을 보정한다. Antigravity IDE 는 agy CLI 가 쓴
 * `~/.gemini/config/mcp_config.json`(`--agent antigravity`) 도 읽어 같은 키 `pluriply` 가
 * 이기므로, IDE 언어 서버가 자식에게 주는 ANTIGRAVITY_EDITOR_APP_ROOT 로 IDE 를 구분한다.
 * @param {string} agent @param {NodeJS.ProcessEnv} env @returns {string}
 */
export function resolveAgentName(agent, env) {
  if (agent === "antigravity" && env.ANTIGRAVITY_EDITOR_APP_ROOT)
    return "antigravity-ide";
  return agent;
}

/** @param {string} tool @param {string} suffix @returns {string} 짧은 표기 `<tool>#<suffix>` */
export function makeInstanceId(tool, suffix) {
  return `${tool}#${suffix}`;
}

/** @param {unknown} s @returns {boolean} */
export function isInstanceId(s) {
  return typeof s === "string" && INSTANCE_RE.test(s);
}

/**
 * send_task의 `to`를 도구 수준/인스턴스 수준으로 나눈다.
 * @param {string} to @returns {{tool: string, instance: string|null}}
 */
export function parseTarget(to) {
  const i = to.indexOf("#");
  if (i === -1) return { tool: to, instance: null };
  return { tool: to.slice(0, i), instance: to };
}

/** @param {string} id 인스턴스 ID 또는 도구 이름 @returns {string} 도구 이름 */
export function toolOf(id) {
  return parseTarget(id).tool;
}

/**
 * 채널 복귀 키. 같은 도구가 같은 작업 폴더에서 뜨면 같은 키다(서브에이전트 포함).
 * @param {string} tool @param {string} cwd @returns {string} `<tool>@<sha256 앞 8자>`
 */
export function cwdKey(tool, cwd) {
  // 심볼릭 링크로 인한 별칭(예: macOS /var → /private/var, cwd 별칭 디렉터리)을
  // 같은 키로 묶는다. 존재하지 않는 경로는 realpath 가 실패하므로 resolve 결과를 쓴다
  // (커넥터가 아직 만들어지지 않은 폴더로 뜨는 드문 경우까지 키를 안정적으로 유지).
  let p = resolve(cwd);
  try {
    p = realpathSync.native(p);
  } catch {
    // 그대로 둔다
  }
  const hash = createHash("sha256").update(p).digest("hex");
  return `${tool}@${hash.slice(0, 8)}`;
}
