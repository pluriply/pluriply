import { existsSync, rmSync, realpathSync, lstatSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { CLIENTS, makeEnv, isSkipped } from "./clients.js";
import { HOOK_CLIENTS, hookStatus, installHook, removeHook } from "./hooks.js";
import { setWorkerEnabled, TEMPLATE_AGENTS } from "../shared/config.js";
import { readLock } from "../shared/lock.js";
// 허브(stopHub)와 커넥터(ensureHub → ws)는 쓰는 순간에만 불러온다. 공개 미러에는 src/hub 가
// 없고 node_modules 도 없을 수 있으므로 이 모듈은 둘 없이 로드돼야 한다(Plan 4e §5).
const hub = () => import("../hub/index.js");
const hubClient = () => import("../connector/hub-client.js");

/** 전체 제거 뒤 항상 출력한다: 열린 세션의 커넥터는 등록 해제와 무관하게 살아 있고 허브를 다시 띄울 수 있다(스펙 §4). */
export const REMOVE_NOTE =
  "note: close or restart open client sessions; their connectors may restart the hub";

/** `--hooks-only` 실행의 첫 줄(스펙 §4.3). MCP 표가 비어 있는 이유를 알려 준다. */
export const HOOKS_ONLY_NOTE =
  "hooks only — MCP registration, workers and hub untouched";

/** @param {string[]|undefined} only */
function resolveTargets(only) {
  if (!only) return CLIENTS;
  return only.map((id) => {
    const c = CLIENTS.find((x) => x.id === id);
    if (!c)
      throw new Error(
        `unknown client: ${id} (known: ${CLIENTS.map((x) => x.id).join(", ")})`,
      );
    return c;
  });
}

/**
 * 클라이언트를 돌며 표 행을 만든다. register/remove 루프가 공유한다.
 * `act` 는 실제 등록/해제 호출, `dryRunResult` 는 (status 문자열) → 결과 문자열,
 * `collect` 는 실패하지 않은 결과에서 워커 활성/비활성 후보를 모은다.
 * `{error}` → `failed: <err>` 매핑과 `"failed"` → `"failed: see hint above"` 매핑은 여기 산다.
 * @param {{targets: object[], e: object, dryRun: boolean, act: (c: object) => string, dryRunResult: (st: string) => string, collect: (c: object, result: string) => void}} opts
 * @returns {{rows: Array<{id: string, label: string, installed: boolean, result: string}>, failed: number}}
 */
function walkClients({ targets, e, dryRun, act, dryRunResult, collect }) {
  const rows = [];
  let failed = 0;
  for (const c of targets) {
    const det = c.detect(e);
    if (!det.installed) {
      rows.push({
        id: c.id,
        label: c.label,
        installed: false,
        result: "not installed",
      });
      continue;
    }
    let result;
    if (dryRun) {
      // PLURIPLY_SKIP_MCP_REGISTER 가 켜져 있으면 register/unregister 와 같은 순서(감지 → 스킵 →
      // 상태조회)로 status() 호출 자체를 건너뛴다 — 안 그러면 dry-run만 진짜로 mcp list 를 쳐서
      // 실행 결과와 어긋난다.
      if (isSkipped(e)) {
        result = "skipped";
      } else {
        const st = c.status(e);
        result =
          typeof st === "object" ? `failed: ${st.error}` : dryRunResult(st);
      }
    } else {
      result = act(c);
      if (result === "failed") result = "failed: see hint above";
    }
    if (result.startsWith("failed")) failed++;
    else collect(c, result);
    rows.push({ id: c.id, label: c.label, installed: true, result });
  }
  return { rows, failed };
}

/**
 * MCP 등록 표(`rows`)를 바탕으로 훅 행을 만든다(스펙 §6). 도구가 감지되지 않았으면 not installed,
 * `hooks:false` 면 skipped, dry-run 은 상태만 본다. 실패는 failed 로 세고 진행한다.
 * @returns {{hookRows: object[], failed: number}}
 */
function walkHooks({ targets, rows, e, dryRun, hooks, remove }) {
  const hookRows = [];
  let failed = 0;
  for (const hc of HOOK_CLIENTS) {
    if (!targets.some((c) => c.id === hc.id)) continue;
    const row = rows.find((x) => x.id === hc.id);
    const installed = Boolean(row?.installed);
    let result;
    if (!installed) result = "not installed";
    else if (!hooks) result = "skipped";
    else if (dryRun) {
      const st = hookStatus(e, hc);
      if (typeof st === "object") result = `failed: ${st.error}`;
      else if (remove) result = st === "missing" ? "absent" : "planned";
      else result = st === "present" ? "present" : "planned";
    } else result = remove ? removeHook(e, hc) : installHook(e, hc);
    if (result === "failed") result = "failed: see hint above";
    if (result.startsWith("failed")) failed++;
    hookRows.push({ id: hc.id, label: hc.label, installed, result });
  }
  return { hookRows, failed };
}

/**
 * `pluriply setup`: 설치된 클라이언트를 감지해 pluriply 커넥터를 멱등 등록한다.
 * `remove` 면 반대로 등록을 풀고 워커 설정·허브·(purge 시) 데이터까지 정리한다.
 * `--purge` 는 pluriply 홈이 심볼릭 링크면 **링크만 끊고** 링크가 가리키는 디렉터리는 남긴다
 * (그 안의 내용까지 지우려면 실제 경로를 직접 지워야 한다).
 * env.stopHub / env.rm / env.lstat 은 테스트가 주입한다.
 * `hooks`(기본 true)는 Claude Code·Codex 의 Stop 훅 등록 여부다(스펙 §6). `--remove` 는 이 값과
 * 무관하게 항상 훅을 제거한다.
 * `hooksOnly`(스펙 §4)는 MCP 등록·워커·허브를 건너뛰고 Stop 훅만 설치(`remove` 면 제거)한다.
 * @param {{only?: string[], workers?: boolean, dryRun?: boolean, remove?: boolean, purge?: boolean, hooks?: boolean, hooksOnly?: boolean, env?: object, home: string}} opts
 */
export async function runSetup({
  only,
  workers = false,
  dryRun = false,
  remove = false,
  purge = false,
  hooks = true,
  hooksOnly = false,
  env,
  home,
}) {
  const e = env ?? makeEnv();
  const targets = resolveTargets(only);
  if (hooksOnly) return runHooksOnly({ targets, e, dryRun, remove });
  if (remove) return runRemove({ targets, only, dryRun, purge, e, home });
  const enabledAgents = [];
  const { rows, failed } = walkClients({
    targets,
    e,
    dryRun,
    act: (c) => c.register(e),
    dryRunResult: (st) => (st === "present" ? "present" : "planned"),
    collect: (c) => {
      if (c.kind === "cli" && TEMPLATE_AGENTS.includes(c.agent))
        enabledAgents.push(c.agent);
    },
  });
  const hk = walkHooks({ targets, rows, e, dryRun, hooks, remove: false });
  if (workers && !dryRun && enabledAgents.length > 0)
    setWorkerEnabled(home, enabledAgents, true);
  const out = {
    rows,
    failed: failed + hk.failed,
    hookRows: hk.hookRows,
    workers: workers && !dryRun ? enabledAgents : [],
  };
  if (!dryRun) {
    try {
      out.hub = { port: (await (await hubClient()).ensureHub({ home })).port };
    } catch (err) {
      out.hubError = err.message;
    }
  }
  return out;
}

/**
 * `--purge` 가드가 **판정에 쓰는** 경로. 문자열 비교만으로는 심볼릭 링크(`/tmp/users-alias/alice` →
 * `/Users/alice`)나 플랫폼 별칭(`/var` → `/private/var`)을 잡을 수 없으므로 realpath 로 정규화한다.
 * 아직 없는 홈은 realpath 가 던지니 resolve 로 물러선다. e.realpath 는 테스트 주입용.
 *
 * 주의: 실제로 `rm` 을 거는 경로는 이게 아니라 `resolve(home)` 이다 — runRemove 주석 참고.
 * @param {string} home @param {object} [e] @returns {string}
 */
function purgeTarget(home, e = {}) {
  const abs = resolve(home);
  try {
    return (e.realpath ?? realpathSync.native)(abs);
  } catch {
    return abs;
  }
}

/** 대소문자를 구분하지 않는 파일시스템(macOS·Windows)에서는 비교도 대소문자를 무시한다. */
function foldCase(p, platform) {
  return platform === "darwin" || platform === "win32" ? p.toLowerCase() : p;
}

/** 루트를 뺀 경로 세그먼트 수. Windows 드라이브 문자(`C:`)는 세지 않는다 — `C:\Users` 는 1. */
function depth(p) {
  return p.split(/[\\/]+/).filter((x) => x !== "" && !/^[A-Za-z]:$/.test(x))
    .length;
}

/**
 * rm -rf 전 정신 확인: 지워선 안 되는 경로면 사람이 읽는 이유를, 괜찮으면 null 을 돌려준다.
 * 거부 대상 — (a) 파일시스템 루트, (b) 사용자 홈 그 자체, (c) 사용자 홈의 상위 디렉터리,
 * (d) 세그먼트가 두 개 미만인 최상위 디렉터리(`/Users`, `/home`, `/etc`, `C:\Users`).
 * e.userHome / e.platform / e.realpath 는 테스트 주입용(어댑터의 env.homeDir 과는 다른 값)이며
 * 기본은 os.homedir() / process.platform 이다.
 * @param {string} home @param {object} [e] @returns {string|null}
 */
export function purgeRefusal(home, e = {}) {
  const platform = e.platform ?? process.platform;
  const target = purgeTarget(home, e);
  const userHome = purgeTarget(e.userHome ?? homedir(), e);
  const t = foldCase(target, platform);
  const u = foldCase(userHome, platform);
  if (dirname(target) === target) return `${target} is a filesystem root`;
  if (t === u) return `${target} resolves to your home directory`;
  if (u.startsWith(t.endsWith(sep) ? t : t + sep))
    return `${target} contains your home directory`;
  // 정규화 전후 둘 다 본다: `/etc` 는 macOS 에서 `/private/etc`(두 칸) 로 풀려 정규화 경로만
  // 보면 통과해버린다.
  if (depth(target) < 2 || depth(resolve(home)) < 2)
    return `${target} is a top-level directory`;
  return null;
}

/**
 * `setup --hooks-only` / `setup --remove --hooks-only`(스펙 §4.2). walkHooks 는 도구 감지 여부를
 * walkClients 의 행(`installed`)에서 읽으므로, 등록을 건드리지 않고 detect 만 돌려 같은 모양의 행을 만든다.
 * 허브는 띄우지도 세우지도 않는다 — 훅은 발동 시점에 connectIfLive 로 허브를 찾는다(D7).
 */
function runHooksOnly({ targets, e, dryRun, remove }) {
  const rows = targets.map((c) => ({
    id: c.id,
    label: c.label,
    installed: Boolean(c.detect(e).installed),
    result: "untouched",
  }));
  const hk = walkHooks({ targets, rows, e, dryRun, hooks: true, remove });
  return {
    mode: remove ? "hooks-only-remove" : "hooks-only",
    rows: [],
    hookRows: hk.hookRows,
    failed: hk.failed,
    workers: [],
    workersDisabled: [],
  };
}

async function runRemove({ targets, only, dryRun, purge, e, home }) {
  const { rows, failed: rowsFailed } = walkClients({
    targets,
    e,
    dryRun,
    act: (c) => c.unregister(e),
    dryRunResult: (st) => (st === "missing" ? "absent" : "planned"),
    // remove 는 워커 비활성화를 행 결과가 아니라 대상 목록 자체로 정하므로(아래 toDisable)
    // 여기서 따로 모을 게 없다.
    collect: () => {},
  });
  // --remove 는 --no-hooks 와 무관하게 항상 훅을 제거한다.
  const hk = walkHooks({ targets, rows, e, dryRun, hooks: true, remove: true });
  const out = {
    mode: "remove",
    rows,
    failed: rowsFailed + hk.failed,
    hookRows: hk.hookRows,
    workers: [],
    workersDisabled: [],
  };
  if (dryRun) {
    // --purge 는 --only 와 함께 실행되지 않는다(허브를 건드리지 않으므로 지울 것도 없다) — CLI 도 이 조합을 거부한다.
    // 계획 단계에서도 실제 실행과 같은 가드를 태운다 — dry-run 이 "지우겠다"고 해놓고
    // 실행이 거부하면(또는 그 반대면) 사용자가 확인할 방법이 없다.
    if (purge && !only) {
      const refusal = purgeRefusal(home, e);
      if (refusal) {
        out.purgeError = refusal;
        out.failed++;
      } else out.purge = `planned ${home}`;
    }
    return out;
  }
  // --only 면 그 실행에서 겨냥한 CLI 템플릿 에이전트 전부(행 결과가 removed/absent/skipped/failed
  // 무엇이든) 비활성, 전체 제거면 템플릿 에이전트 전부 비활성. config.json 이 없으면 만들지 않는다.
  // 행 결과로만 판단하면(예: removed 만) MCP 등록이 이미 없는(absent) 워커가 config.json 에는
  // enabled:true 로 남아 허브가 계속 받아준다 — worker enable 로 등록 없이 활성화될 수 있어서다.
  const toDisable = only
    ? targets
        .filter((c) => c.kind === "cli" && TEMPLATE_AGENTS.includes(c.agent))
        .map((c) => c.agent)
    : [...TEMPLATE_AGENTS];
  if (toDisable.length > 0 && existsSync(join(home, "config.json"))) {
    try {
      setWorkerEnabled(home, toDisable, false);
      out.workersDisabled = toDisable;
    } catch (err) {
      out.workersError = err.message;
      out.failed++;
    }
  }
  if (only) return out;
  try {
    const stop = e.stopHub ?? (await hub()).stopHub;
    out.hub = await stop({ home });
  } catch (err) {
    out.hubError = err.message;
    out.failed++;
  }
  if (out.hub === "timeout") {
    out.hubPid = readLock(home)?.pid;
    out.failed++;
  } else if (out.hub && purge) {
    const refusal = purgeRefusal(home, e);
    if (refusal) {
      out.purgeError = refusal;
      out.failed++;
    } else {
      // 판정은 정규화된 경로로(위 purgeRefusal), 삭제는 **정규화하지 않은** 경로로 한다.
      // realpath 를 지우면 `~/.pluriply` 가 다른 디렉터리로의 심볼릭 링크일 때 그 바깥 디렉터리가
      // 통째로 재귀 삭제되고 끊어진 링크만 남는다 — pluriply 소유가 아닌 데이터가 사라진다.
      // rmSync 는 링크를 따라가지 않으므로 링크 경로를 그대로 주면 링크만 끊긴다(대상은 그대로).
      const raw = resolve(home);
      let symlinked = false;
      try {
        symlinked = (e.lstat ?? lstatSync)(raw).isSymbolicLink();
      } catch {
        // 경합으로 사라졌거나 못 읽으면 평범한 디렉터리로 보고 문구만 단순하게 간다
      }
      (e.rm ?? rmSync)(raw, { recursive: true, force: true });
      out.purge = symlinked
        ? `removed ${home} (symlink unlinked; target kept)`
        : `removed ${home}`;
    }
  }
  out.note = REMOVE_NOTE;
  return out;
}

/** @param {object[]} hookRows @returns {string[]} */
function hookLines(hookRows) {
  return (hookRows ?? []).map(
    (row) =>
      `hooks ${row.id.padEnd(12)} ${row.installed ? "installed    " : "not installed"} ${row.result}`,
  );
}
/** Codex 는 새 훅을 다음 세션에서 신뢰 승인해야 한다 — 새로 쓰였을 때만 안내한다. @param {object[]} hookRows */
function codexTrustHint(hookRows) {
  return (hookRows ?? []).some(
    (x) =>
      x.id === "codex" && (x.result === "registered" || x.result === "updated"),
  )
    ? [
        "hint: Codex asks to trust the new hook in its next session — approve it.",
      ]
    : [];
}

/** @param {Awaited<ReturnType<typeof runSetup>>} r @returns {string[]} 사람이 읽는 표 */
export function formatSetup(r, { workers = false } = {}) {
  if (r.mode === "hooks-only" || r.mode === "hooks-only-remove")
    return [
      HOOKS_ONLY_NOTE,
      ...hookLines(r.hookRows),
      ...codexTrustHint(r.hookRows),
    ];
  const lines = r.rows.map(
    (row) =>
      `${row.id.padEnd(16)} ${row.installed ? "installed    " : "not installed"} ${row.result}`,
  );
  lines.push(...hookLines(r.hookRows));
  if (r.mode === "remove") {
    if (r.workersDisabled.length)
      lines.push(`workers disabled: ${r.workersDisabled.join(", ")}`);
    if (r.workersError)
      lines.push(`workers: could not update config (${r.workersError})`);
    if (r.hub === "stopped") lines.push("hub: stopped");
    else if (r.hub === "not-running") lines.push("hub: not running");
    else if (r.hub === "timeout")
      lines.push(
        `hub: failed to stop within 5s (pid ${r.hubPid ?? "unknown"})`,
      );
    else if (r.hubError) lines.push(`hub: could not stop (${r.hubError})`);
    if (r.purge) lines.push(`purge: ${r.purge}`);
    if (r.purgeError) lines.push(`purge: refused (${r.purgeError})`);
    if (r.note) lines.push(r.note);
    return lines;
  }
  if (r.hub) lines.push(`hub: running on port ${r.hub.port}`);
  if (r.hubError) lines.push(`hub: could not start (${r.hubError})`);
  if (r.workers.length) lines.push(`workers enabled: ${r.workers.join(", ")}`);
  else if (!workers) {
    const cli = r.rows
      .filter((x) => x.installed && TEMPLATE_AGENTS.includes(x.id))
      .map((x) => x.id);
    if (cli.length)
      lines.push(
        `hint: run \`pluriply worker enable <${cli.join("|")}>\` to let the hub run that tool headlessly (or re-run setup --workers)`,
      );
  }
  lines.push(...codexTrustHint(r.hookRows));
  return lines;
}
