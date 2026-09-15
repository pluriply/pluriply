// Stop 훅 설치·제거 어댑터(스펙 §6). 대상 파일의 hooks.Stop[] 에 우리 그룹 하나를 병합하고,
// 다른 그룹(사용자·다른 도구의 훅)은 순서까지 보존한다. 쓰기는 clients.js 의 백업·원자 쓰기.
import { join, dirname } from "node:path";
import { writeJsonAtomic } from "./clients.js";

export const HOOK_TIMEOUT_SEC = 10;

/**
 * `layout` 이 없으면(claude-code·codex) 스펙 §3 의 stop-groups 모양(`hooks.Stop[].hooks[]`)을 쓴다.
 * `layout: "named"`(antigravity) 는 이름 키 아래 **평평한** 항목 배열을 쓴다 — 실기기 확인(2026-09-16).
 * @type {Array<{id: string, label: string, file: (env: object) => string, layout?: "named"}>}
 */
export const HOOK_CLIENTS = [
  {
    id: "claude-code",
    label: "Claude Code hooks",
    file: (env) => join(env.homeDir, ".claude", "settings.json"),
  },
  {
    id: "codex",
    label: "Codex hooks",
    file: (env) =>
      join(
        env.processEnv?.CODEX_HOME || join(env.homeDir, ".codex"),
        "hooks.json",
      ),
  },
  {
    id: "antigravity",
    label: "Antigravity hooks",
    file: (env) => join(env.homeDir, ".gemini", "config", "hooks.json"),
    layout: "named",
  },
];

/** named 레이아웃에서 우리 항목을 담는 최상위 키 */
const NAMED_KEY = "pluriply";

/** @param {object} env @param {string} agent @returns {string} */
export function hookCommand(env, agent) {
  return `"${env.node}" "${env.binPath}" hook stop --agent ${agent}`;
}

/**
 * command 문자열에서 우리가 심은 `--agent` 값을 뽑는다. 끝에 정확히 고정한다 — `.includes`
 * 였다면 `--agent antigravity`가 `--agent antigravity-ide`의 접두사라 서로를 자기 것으로
 * 착각하거나(더 긴 이름), 뒤에 다른 인자가 붙은 남의 명령까지 우리 것으로 삼켰다.
 * @param {unknown} cmd @returns {string|undefined}
 */
function agentOf(cmd) {
  return typeof cmd === "string"
    ? /pluriply\.js" hook stop --agent (\S+)\s*$/.exec(cmd)?.[1]
    : undefined;
}

/** 우리 그룹인지(stop-groups): 훅 중 하나의 --agent 값이 정확히 agent 다 */
function isOurs(group, agent) {
  return (
    Array.isArray(group?.hooks) &&
    group.hooks.some((h) => agentOf(h?.command) === agent)
  );
}

/** 우리 항목인지(named 레이아웃의 평평한 항목) */
function isOursFlat(item, agent) {
  return agentOf(item?.command) === agent;
}

function ourGroup(env, agent) {
  return {
    hooks: [
      {
        type: "command",
        command: hookCommand(env, agent),
        timeout: HOOK_TIMEOUT_SEC,
      },
    ],
  };
}

/** named 레이아웃에 쓰는 평평한 항목 하나 */
function ourFlatItem(env, agent) {
  return {
    type: "command",
    command: hookCommand(env, agent),
    timeout: HOOK_TIMEOUT_SEC,
  };
}

/**
 * 문서에서 우리 Stop 항목을 찾는다. 레이아웃(stop-groups/named)에 따라 다른 모양을 읽되
 * hookStatus 는 이 공통 반환값만 보면 되게 한다.
 * @param {object} doc @param {object} hc @param {object} env
 * @returns {{stopArr: object[], idx: number, mine: object|null, matches: boolean}}
 */
function readOurs(doc, hc, env) {
  const want = hookCommand(env, hc.id);
  if (hc.layout === "named") {
    const stopArr = Array.isArray(doc[NAMED_KEY]?.Stop)
      ? doc[NAMED_KEY].Stop
      : [];
    const idx = stopArr.findIndex((h) => isOursFlat(h, hc.id));
    const mine = idx === -1 ? null : stopArr[idx];
    const matches =
      mine != null &&
      mine.type === "command" &&
      mine.command === want &&
      mine.timeout === HOOK_TIMEOUT_SEC;
    return { stopArr, idx, mine, matches };
  }
  const stopArr = Array.isArray(doc.hooks?.Stop) ? doc.hooks.Stop : [];
  const idx = stopArr.findIndex((g) => isOurs(g, hc.id));
  const mine = idx === -1 ? null : stopArr[idx];
  const matches =
    mine != null &&
    mine.hooks.length === 1 &&
    mine.hooks[0].type === "command" &&
    mine.hooks[0].command === want &&
    mine.hooks[0].timeout === HOOK_TIMEOUT_SEC;
  return { stopArr, idx, mine, matches };
}

/**
 * 우리 항목을 심은/갈아 끼운 새 문서를 돌려준다(설치 전용). named 레이아웃은 `doc.pluriply` 를
 * 통째로 새로 쓴다(우리만 쓰는 키라 병합할 다른 항목이 없다) — 다른 최상위 키는 그대로 둔다.
 * stop-groups 는 기존처럼 그룹 하나만 심거나 갈아 끼우고 다른 그룹·다른 훅 이벤트는 보존한다.
 * @param {object} doc @param {object} hc @param {object} env
 * @returns {object}
 */
function writeOurs(doc, hc, env) {
  if (hc.layout === "named") {
    return { ...doc, [NAMED_KEY]: { Stop: [ourFlatItem(env, hc.id)] } };
  }
  const hooks =
    doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks)
      ? doc.hooks
      : {};
  const stopArr = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const idx = stopArr.findIndex((g) => isOurs(g, hc.id));
  const group = ourGroup(env, hc.id);
  const nextStop =
    idx === -1
      ? [...stopArr, group]
      : stopArr.map((g, j) => (j === idx ? group : g));
  return { ...doc, hooks: { ...hooks, Stop: nextStop } };
}

/** @returns {object} 파일 없음·빈 파일은 {} ; JSON 이 아니거나 객체가 아니면 throw */
function readDoc(env, path) {
  if (!env.fs.existsSync(path)) return {};
  const raw = env.fs.readFileSync(path, "utf8");
  if (raw.trim() === "") return {};
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error("hooks file root is not an object");
  return doc;
}

/** @returns {"present"|"stale"|"missing"|{error: string}} */
export function hookStatus(env, hc) {
  const path = hc.file(env);
  let doc;
  try {
    doc = readDoc(env, path);
  } catch (err) {
    return { error: `${path}: ${err.message}` };
  }
  const { mine, matches } = readOurs(doc, hc, env);
  if (!mine) return "missing";
  return matches ? "present" : "stale";
}

/** @returns {"present"|"updated"|"registered"|"failed"} */
export function installHook(env, hc) {
  const path = hc.file(env);
  const st = hookStatus(env, hc);
  if (st === "present") return "present";
  if (typeof st === "object") {
    env.log(`cannot update ${hc.label}: ${st.error}`);
    if (hc.layout === "named") {
      env.log(
        `add this to ${NAMED_KEY}.Stop in ${path} yourself: ${JSON.stringify({ Stop: [ourFlatItem(env, hc.id)] })}`,
      );
    } else {
      env.log(
        `add this to hooks.Stop in ${path} yourself: ${JSON.stringify(ourGroup(env, hc.id))}`,
      );
    }
    return "failed";
  }
  const doc = readDoc(env, path);
  const next = writeOurs(doc, hc, env);
  env.fs.mkdirSync?.(dirname(path), { recursive: true });
  writeJsonAtomic(env, path, next);
  env.log(
    `${st === "missing" ? "installed" : "updated"} pluriply Stop hook in ${hc.label} (${path}, backup ${path}.bak)`,
  );
  return st === "missing" ? "registered" : "updated";
}

/** @returns {"removed"|"absent"|"failed"} */
export function removeHook(env, hc) {
  const path = hc.file(env);
  if (!env.fs.existsSync(path)) return "absent";
  let doc;
  try {
    doc = readDoc(env, path);
  } catch (err) {
    env.log(`cannot update ${hc.label}: ${path}: ${err.message}`);
    return "failed";
  }
  if (hc.layout === "named") {
    if (!(NAMED_KEY in doc)) return "absent";
    const next = { ...doc };
    delete next[NAMED_KEY];
    writeJsonAtomic(env, path, next);
    env.log(
      `removed pluriply Stop hook from ${hc.label} (${path}, backup ${path}.bak)`,
    );
    return "removed";
  }
  const stop = Array.isArray(doc.hooks?.Stop) ? doc.hooks.Stop : [];
  const rest = stop.filter((g) => !isOurs(g, hc.id));
  if (rest.length === stop.length) return "absent";
  const hooks = { ...doc.hooks };
  if (rest.length) hooks.Stop = rest;
  else delete hooks.Stop;
  writeJsonAtomic(env, path, { ...doc, hooks });
  env.log(
    `removed pluriply Stop hook from ${hc.label} (${path}, backup ${path}.bak)`,
  );
  return "removed";
}
