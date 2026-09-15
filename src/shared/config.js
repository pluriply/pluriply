import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";

/** 내장 워커 템플릿이 있는 에이전트. 허브(worker-templates.js)와 setup 이 같이 쓴다. */
export const TEMPLATE_AGENTS = ["codex", "claude-code", "antigravity"];

/** 워커 상한 기본값 */
export const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 2,
  timeoutMs: 20 * 60 * 1000,
  maxConcurrentPerAgent: 1,
  maxQueuedPerAgent: 10,
});

/**
 * `<home>/config.json`. 없거나 손상되면 기본값.
 * @param {string} home
 * @returns {{workers: object, limits: {maxDepth: number, timeoutMs: number, maxConcurrentPerAgent: number, maxQueuedPerAgent: number}, allowedRoots: string[]}}
 */
export function loadConfig(home) {
  const file = join(home, "config.json");
  let doc = {};
  if (existsSync(file)) {
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      doc = {};
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) doc = {};
  const workers =
    doc.workers &&
    typeof doc.workers === "object" &&
    !Array.isArray(doc.workers)
      ? doc.workers
      : {};
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const v = doc.limits?.[key];
    if (Number.isInteger(v) && v > 0) limits[key] = v;
  }
  const allowedRoots = Array.isArray(doc.allowedRoots)
    ? doc.allowedRoots.filter((r) => typeof r === "string" && isAbsolute(r))
    : [];
  return { workers, limits, allowedRoots };
}

/**
 * @param {string} home @param {object} doc tmp+rename으로 원자 저장.
 * home 이 아직 없는 새 설치(허브를 한 번도 안 띄운 상태에서 setup --workers, worker enable 이
 * 먼저 실행되는 경우)에서도 ENOENT 없이 만들어지도록 폴더를 먼저 보장한다.
 */
export function saveConfig(home, doc) {
  mkdirSync(home, { recursive: true });
  const file = join(home, "config.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  renameSync(tmp, file);
}

/** @returns {boolean} */
export function workerEnabled(config, agent) {
  return config.workers[agent]?.enabled === true;
}

/**
 * 원본 config.json 문서를 다시 읽어 workers 만 병합한다. loadConfig 가 돌려주는 값은
 * limits·allowedRoots 에 기본값이 채워진 파생값이라 그대로 되쓰면 사용자가 넣은 다른 키가
 * 사라지므로 파일을 직접 읽는다(없거나 손상되면 {}). enable 은 {...기존, enabled: true} 병합,
 * disable 은 키 삭제. bin `worker enable|disable`, `setup --workers`, `setup --remove` 가 쓴다.
 * @param {string} home @param {string[]} agents @param {boolean} enabled
 */
export function setWorkerEnabled(home, agents, enabled) {
  const file = join(home, "config.json");
  let rawDoc = {};
  if (existsSync(file)) {
    try {
      rawDoc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      rawDoc = {};
    }
  }
  if (!rawDoc || typeof rawDoc !== "object" || Array.isArray(rawDoc))
    rawDoc = {};
  const workers =
    rawDoc.workers &&
    typeof rawDoc.workers === "object" &&
    !Array.isArray(rawDoc.workers)
      ? { ...rawDoc.workers }
      : {};
  for (const a of agents) {
    if (enabled) workers[a] = { ...(workers[a] ?? {}), enabled: true };
    else delete workers[a];
  }
  saveConfig(home, { ...rawDoc, workers });
}
