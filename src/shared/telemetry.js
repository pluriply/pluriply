import {
  realpathSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { hasHint, markHint } from "./hints.js";

// 익명 하루 사용 신호(telemetry 설계 §5). 보낼 내용·끄는 조건·상태 파일·전송을 한곳에 둔다.
// src/hub 를 가져오지 않는다(공개 미러에는 허브가 없다).

export const TELEMETRY_URL = "https://t.pluriply.com/v1/ping";
export const TELEMETRY_NOTICE =
  "Pluriply sends an anonymous daily usage count (version, OS, tool names, task counts — never your prompts, code, or paths). Turn it off: npx pluriply telemetry off";
export const TELEMETRY_REMINDER =
  "Pluriply keeps an anonymous daily usage count (no prompts, code, or paths). The user can check it with npx pluriply status and turn it off with npx pluriply telemetry off. Mention this once.";
export const KNOWN_TOOLS = ["claude-code", "codex", "antigravity"];
export const MIN_GAP_MS = 20 * 3600_000;

const DAY_MS = 24 * 3600_000;
const COUNTS_KEEP_MS = 48 * 3600_000;
const COUNTS_MAX = 1000;
const CHANNEL_FILE = /^plp-[a-z0-9-]+\.json$/;
const CI_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "JENKINS_URL",
  "TF_BUILD",
];

const statePath = (home) => join(home, "telemetry.json");
const countsPath = (home) => join(home, "telemetry-counts.json");
/**
 * 끄기 표시. telemetry.json 은 허브(noteTool·maybeSend)와 CLI(off/on)가 서로 다른 프로세스에서
 * 읽고-고쳐-쓰므로, off 뒤에 옛 상태가 덮여 `enabled:false` 가 사라질 수 있다. 표시는 off/on 만
 * 만들고 지우므로 그런 덮어쓰기에 지워지지 않는다.
 */
const offPath = (home) => join(home, "telemetry-off");
/**
 * 환경 변수 끄기의 기억. 허브는 자기를 띄운 프로세스의 환경을 물려받는데, Codex 는 MCP 서버 환경을 거르고
 * Dock·IDE 로 띄운 도구에는 셸 설정의 변수가 없다. 그래서 어떤 pluriply 명령이나 AI 창이 한 번이라도
 * 변수를 보면 여기에 남기고, `telemetry on` 만 지운다(변수가 사라져도 남는다). 내용은 그때의 이유.
 */
const envOffPath = (home) => join(home, "telemetry-env-off");
const ENV_REASONS = ["env", "do-not-track", "ci"];
/** 한 날 한 칸의 상한 — 서버가 이보다 큰 값을 거절한다 */
const COUNT_MAX = 100_000;

/** 없거나 손상이면 null, 객체일 때만 돌려준다 */
function readObject(file) {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** tmp+rename(hints.js 와 같은 방식) */
function writeAtomic(file, text, mode) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, mode ? { mode } : undefined);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function writeJson(file, doc, mode) {
  writeAtomic(file, JSON.stringify(doc), mode);
}

/** 끄기 표시 파일이 있거나 상태에 enabled:false 가 있으면 꺼진 것이다 */
function turnedOff(home) {
  return existsSync(offPath(home)) || readState(home).enabled === false;
}

/** @param {string} home */
export function readState(home) {
  const doc = readObject(statePath(home));
  if (!doc) return { toolsSeen: {} };
  const state = { toolsSeen: {} };
  if (typeof doc.id === "string") state.id = doc.id;
  if (typeof doc.enabled === "boolean") state.enabled = doc.enabled;
  if (typeof doc.lastSentAt === "string") state.lastSentAt = doc.lastSentAt;
  const seen = doc.toolsSeen;
  if (seen && typeof seen === "object" && !Array.isArray(seen))
    for (const [k, v] of Object.entries(seen))
      if (typeof v === "string") state.toolsSeen[k] = v;
  return state;
}

/** @param {string} home @param {object} state */
export function writeState(home, state) {
  writeJson(statePath(home), state, 0o600);
}

/** 실경로(없으면 resolve) — macOS /var ↔ /private/var 같은 별칭을 맞춘다 */
function realOf(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const truthy = (v) => typeof v === "string" && v !== "";

/** 환경 변수가 끈 이유(없으면 null) @returns {null|"env"|"do-not-track"|"ci"} */
function envReason(env) {
  if (/^(0|false|off)$/i.test(env.PLURIPLY_TELEMETRY ?? "")) return "env";
  if (/^(1|true)$/i.test(env.DO_NOT_TRACK ?? "")) return "do-not-track";
  if (CI_KEYS.some((k) => truthy(env[k]))) return "ci";
  return null;
}

/** 기억해 둔 환경 끄기 이유(없으면 null). 읽을 수 없거나 모르는 내용이면 "env" 로 본다. */
function envMarkerReason(home) {
  let text;
  try {
    text = readFileSync(envOffPath(home), "utf8");
  } catch (err) {
    return err?.code === "ENOENT" ? null : "env";
  }
  const why = text.trim();
  return ENV_REASONS.includes(why) ? why : "env";
}

/**
 * 환경 변수 끄기(env·do-not-track·ci)가 보이면 `<home>/telemetry-env-off` 에 그 이유를 남긴다(tmp+rename).
 * 이미 같은 이유가 있으면 쓰지 않는다. 절대 throw 하지 않는다.
 * @param {string} home @param {NodeJS.ProcessEnv} [env]
 */
export function noteEnvOptOut(home, env = process.env) {
  try {
    const why = envReason(env);
    if (!why) return;
    try {
      if (readFileSync(envOffPath(home), "utf8") === why) return;
    } catch {
      // 없거나 못 읽으면 새로 쓴다
    }
    writeAtomic(envOffPath(home), why, 0o600);
  } catch {
    // 무시 — 명령·커넥터에 영향을 주지 않는다
  }
}

/**
 * 보내면 안 되는 이유(없으면 null). 순서는 설계 §5.3. 환경 변수가 없어도 기억해 둔 환경 끄기
 * (telemetry-env-off)가 있으면 그 이유를 돌려준다(temp-home 보다 앞).
 * @returns {null|"not-notified"|"turned-off"|"env"|"do-not-track"|"ci"|"temp-home"}
 */
export function disabledReason({
  home,
  env = process.env,
  tmpRoot = tmpdir(),
  ignoreNotice = false,
}) {
  if (!ignoreNotice && !hasHint(home, "telemetry")) return "not-notified";
  if (turnedOff(home)) return "turned-off";
  const fromEnv = envReason(env) ?? envMarkerReason(home);
  if (fromEnv) return fromEnv;
  if (!env.PLURIPLY_TELEMETRY_URL) {
    const root = realOf(tmpRoot);
    const h = realOf(home);
    if (h === root || h.startsWith(root + sep)) return "temp-home";
  }
  return null;
}

/**
 * off 는 먼저 끄기 표시를 만들고(그 순간부터 보내지 않는다) id·lastSentAt 을 지운다. 꺼져 있던 것을 on 하면
 * id·lastSentAt 없이 쓴 뒤(다음 전송에서 새 id) 표시를 지운다 — 경합으로 옛 id 가 되살아났어도 다시 쓰지
 * 않는다. 이미 켜져 있으면 enabled:true 만 맞추고 id 는 둔다(같은 설치를 두 번 세지 않게).
 * on 은 환경 끄기 기억(telemetry-env-off)도 지운다 — 그것을 지우는 곳은 여기뿐이다. 기억이 있었으면 꺼져
 * 있던 것으로 보고 새 id 로 시작한다.
 */
export function setEnabled(home, on) {
  if (!on) writeAtomic(offPath(home), new Date().toISOString(), 0o600);
  const wasOff =
    !on || turnedOff(home) || existsSync(envOffPath(home));
  const state = readState(home);
  state.enabled = Boolean(on);
  if (wasOff) {
    delete state.id;
    delete state.lastSentAt;
  }
  writeState(home, state);
  if (on) {
    rmSync(offPath(home), { force: true });
    rmSync(envOffPath(home), { force: true });
  }
}

/** 기록 실패는 허브·CLI 에 영향을 주지 않는다. */
export function noteTool(home, tool, now = new Date()) {
  try {
    const name = KNOWN_TOOLS.includes(tool) ? tool : "other";
    const state = readState(home);
    state.toolsSeen[name] = now.toISOString();
    writeState(home, state);
  } catch {
    // 무시
  }
}

function readViewTimes(home) {
  const list = readObject(countsPath(home))?.viewOpened;
  return Array.isArray(list) ? list.filter((s) => typeof s === "string") : [];
}

export function noteViewOpened(home, now = new Date()) {
  try {
    const cutoff = now.getTime() - COUNTS_KEEP_MS;
    const kept = readViewTimes(home).filter((s) => Date.parse(s) >= cutoff);
    kept.push(now.toISOString());
    writeJson(countsPath(home), { viewOpened: kept.slice(-COUNTS_MAX) });
  } catch {
    // 무시
  }
}

/** 지난 24시간(미래 시각 제외) 태스크 수. 채널 문서는 읽기만 한다(view/server.js 와 같은 방식). */
function countTasks(home, now) {
  const until = now.getTime();
  const since = until - DAY_MS;
  const out = { sent: 0, completed: 0, failed: 0 };
  let names;
  try {
    names = readdirSync(join(home, "channels")).filter((n) =>
      CHANNEL_FILE.test(n),
    );
  } catch {
    return out;
  }
  for (const name of names) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(home, "channels", name), "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(doc?.tasks)) continue;
    for (const task of doc.tasks) {
      if (!task || typeof task !== "object") continue;
      const at = Date.parse(task.createdAt);
      if (!(at >= since && at <= until)) continue;
      out.sent++;
      if (task.status === "completed") out.completed++;
      else if (task.status === "failed") out.failed++;
    }
  }
  return out;
}

export function buildPayload({
  home,
  now = new Date(),
  version,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
}) {
  const state = readState(home);
  const since = now.getTime() - DAY_MS;
  const tools = Object.entries(state.toolsSeen)
    .filter(
      ([name, at]) =>
        (KNOWN_TOOLS.includes(name) || name === "other") &&
        Date.parse(at) >= since,
    )
    .map(([name]) => name)
    .sort();
  const viewOpened = readViewTimes(home).filter(
    (s) => Date.parse(s) >= since,
  ).length;
  return {
    schema: 1,
    id: state.id ?? null,
    version,
    os: `${platform}-${arch}`,
    node: Number.parseInt(nodeVersion, 10),
    tools,
    last24h: Object.fromEntries(
      Object.entries({ ...countTasks(home, now), viewOpened }).map(
        ([k, n]) => [k, Math.min(n, COUNT_MAX)],
      ),
    ),
  };
}

/** 절대 throw 하지 않는다. */
export async function maybeSend({
  home,
  now = new Date(),
  env = process.env,
  version,
  fetchImpl = fetch,
  url = env.PLURIPLY_TELEMETRY_URL ?? TELEMETRY_URL,
  timeoutMs = 5000,
}) {
  try {
    const reason = disabledReason({ home, env });
    if (reason) return { sent: false, reason };
    const state = readState(home);
    const last = Date.parse(state.lastSentAt ?? "");
    if (last <= now.getTime() && now.getTime() - last < MIN_GAP_MS)
      return { sent: false, reason: "recent" };
    if (!state.id) {
      state.id = randomUUID();
      writeState(home, state);
    }
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPayload({ home, now, version })),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // 읽지 않을 본문은 닫아 연결을 놓는다
      try {
        await res.body?.cancel();
      } catch {
        // 무시
      }
      return { sent: false, reason: `http-${res.status}` };
    }
    // 전송 중 끄기(off)가 일어났을 수 있어 다시 확인하고 다시 읽어 더한다
    if (!turnedOff(home)) {
      const fresh = readState(home);
      fresh.lastSentAt = now.toISOString();
      writeState(home, fresh);
    }
    return { sent: true, reason: "ok" };
  } catch {
    return { sent: false, reason: "error" };
  }
}

/**
 * 처음 한 번만 보이는 안내 줄. 힌트가 없으면 빈 줄 + 안내문을 돌려준다. mark 가 참일 때만 알렸다고
 * 기록한다(기록 실패는 무시) — 사람이 보지 않는 출력(파이프)으로는 알린 것으로 치지 않는다.
 * @param {string} home @param {{mark?: boolean}} [o] @returns {string[]}
 */
export function printTelemetryNotice(home, { mark = true } = {}) {
  if (hasHint(home, "telemetry")) return [];
  if (mark) {
    try {
      markHint(home, "telemetry");
    } catch {
      // 기록 실패는 안내를 막지 않는다
    }
  }
  return ["", TELEMETRY_NOTICE];
}
