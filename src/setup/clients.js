import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  realpathSync,
  statSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { agyCommand } from "../shared/agy.js";
import { insertTomlKey, removeTomlSections } from "./toml-lite.js";

/**
 * 도구별 pluriply MCP 서버 등록 명령. `list`로 이미 등록됐는지 보고 없으면 `add`한다.
 * claude-code 는 워커 템플릿이 --mcp-config 로 인라인 등록하므로 여기 없다.
 * @type {Record<string, {label: string, list: string[], add: (node: string, bin: string) => string[], hint: (bin: string) => string}>}
 */
export const MCP_REGISTRARS = {
  codex: {
    label: "Codex",
    list: ["codex", "mcp", "list"],
    add: (node, bin) => [
      "codex",
      "mcp",
      "add",
      "pluriply",
      "--",
      node,
      bin,
      "connector",
      "--agent",
      "codex",
    ],
    hint: (bin) =>
      `codex mcp add pluriply -- node "${bin}" connector --agent codex`,
  },
  antigravity: {
    label: "Antigravity CLI",
    // agy mcp add 는 user 스코프가 기본이다. `--` 는 필수: 뒤의 명령·인자가 `-` 로 시작할 수
    // 있고(--agent), 플래그는 <name> 앞에만 올 수 있다(agy mcp add --help).
    list: [agyCommand(), "mcp", "list"],
    add: (node, bin) => [
      agyCommand(),
      "mcp",
      "add",
      "pluriply",
      "--",
      node,
      bin,
      "connector",
      "--agent",
      "antigravity",
    ],
    hint: (bin) =>
      `agy mcp add pluriply -- node "${bin}" connector --agent antigravity`,
  },
};

/**
 * 어댑터가 쓰는 환경. 테스트는 exec/fs/homeDir/platform 을 주입한다.
 * @param {object} [o]
 */
export function makeEnv(o = {}) {
  return {
    exec: execFileSync,
    log: console.log,
    binPath: o.binPath,
    homeDir: homedir(),
    platform: process.platform,
    node: process.execPath,
    processEnv: process.env,
    fs: {
      existsSync,
      readFileSync,
      writeFileSync,
      copyFileSync,
      renameSync,
      realpathSync,
      statSync,
      chmodSync,
      mkdirSync,
    },
    ...o,
  };
}

/** 테스트용 스킵 변수(구형 PLURIPLY_SKIP_CODEX_MCP 도 인정) */
export function isSkipped(env) {
  return Boolean(
    env.processEnv.PLURIPLY_SKIP_MCP_REGISTER ||
    env.processEnv.PLURIPLY_SKIP_CODEX_MCP,
  );
}

/**
 * MCP 도구 호출 타임아웃(초). ask_agent·request_review 의 wait_seconds 상한 300 의 두 배(스펙 §5).
 * Codex `tool_timeout_sec`, Antigravity CLI·IDE `timeoutSeconds` 에 쓴다. Claude Code 는 stdio 유휴
 * 30분에 progress 로 유지되고 Claude Desktop 은 설정 키가 없어 대상이 아니다.
 */
export const TOOL_TIMEOUT_SEC = 600;

/**
 * @param {"claude-desktop"|"antigravity-ide"} id
 * Antigravity 는 2.x 부터 IDE(`~/.gemini/antigravity-ide`) 와 허브(`~/.gemini/antigravity`) 로
 * 데이터 폴더가 갈라졌다. IDE 폴더가 있으면 그쪽, 없으면(구버전) 옛 경로.
 */
export function configPath(
  id,
  { homeDir, platform, processEnv = {}, fs = { existsSync } },
) {
  if (id === "antigravity-ide") {
    const ideDir = join(homeDir, ".gemini", "antigravity-ide");
    const dir = fs.existsSync(ideDir)
      ? ideDir
      : join(homeDir, ".gemini", "antigravity");
    return join(dir, "mcp_config.json");
  }
  if (platform === "darwin")
    return join(
      homeDir,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  if (platform === "win32")
    return join(
      processEnv.APPDATA ?? join(homeDir, "AppData", "Roaming"),
      "Claude",
      "claude_desktop_config.json",
    );
  return join(homeDir, ".config", "Claude", "claude_desktop_config.json");
}

/** codex 설정 파일. CODEX_HOME 이 있으면 그 폴더. */
export function codexConfigPath({ homeDir, processEnv = {} }) {
  return join(processEnv.CODEX_HOME || join(homeDir, ".codex"), "config.toml");
}

/** Antigravity CLI(agy)가 `agy mcp add` 로 쓰는 파일 */
export function agyConfigPath({ homeDir }) {
  return join(homeDir, ".gemini", "config", "mcp_config.json");
}

/**
 * Claude Code 의 user-scope(`-s user`) pluriply 등록 여부만 판정한다.
 * `claude mcp list`/`claude mcp get` 은 project-local 등 모든 스코프를 합쳐 보여주므로, 이 저장소처럼
 * project-local 에도 pluriply 가 등록돼 있으면 user 스코프가 비어 있어도 "있다"고 오판해서
 * `setup --remove` 로 user 스코프를 지운 뒤 `setup` 을 다시 돌려도 재등록을 건너뛰게 된다.
 * user-scope 서버는 `~/.claude.json` 최상위 `mcpServers.<name>` 에만 저장되고(프로젝트별 항목은
 * `projects["<경로>"].mcpServers` 아래) 이 파일은 읽기 전용으로만 다룬다 — 여기서 쓰지 않는다.
 * 파일이 없으면(첫 실행 전) missing, 파싱 실패·루트가 객체가 아니면 null(= `mcp list` 폴백).
 * CLAUDE_CONFIG_DIR 가 있으면 Claude Code 가 이 파일을 그 폴더로 옮기므로 홈 대신 그쪽을 본다.
 * @param {object} env
 * @returns {"present"|"missing"|null}
 */
function claudeUserScopeStatus(env) {
  const dir = env.processEnv?.CLAUDE_CONFIG_DIR;
  const path = join(dir || env.homeDir, ".claude.json");
  if (!env.fs.existsSync(path)) return "missing";
  try {
    const doc = JSON.parse(env.fs.readFileSync(path, "utf8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    const servers = doc.mcpServers;
    // hasOwn: 프로토타입 체인을 타지 않는다 — `{"mcpServers":{}}` 의 constructor 같은 상속 키가
    // 등록으로 보이면 안 된다.
    if (!servers || typeof servers !== "object" || Array.isArray(servers))
      return "missing";
    return Object.hasOwn(servers, "pluriply") ? "present" : "missing";
  } catch {
    return null;
  }
}

/** JSON 설정 파일을 읽는다. 빈 파일은 { mcpServers: {} }, 루트가 객체가 아니면 던진다. */
function readJsonDoc(env, path) {
  const raw = env.fs.readFileSync(path, "utf8");
  if (raw.trim() === "") return { mcpServers: {} };
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error("config root is not an object");
  return doc;
}

/** 대상이 아직 없을 때 쓰는 보수적인 모드. 새 설정 파일에 API 키가 들어갈 수 있다. */
const FRESH_FILE_MODE = 0o600;

/**
 * `.bak` 백업 뒤 tmp+rename 으로 쓴다(JSON·TOML 공용).
 *
 * 두 가지를 지킨다.
 * - **심볼릭 링크는 따라간다**: dotfiles 저장소로 링크된 `~/.codex/config.toml` 을 rename 으로
 *   덮으면 링크가 일반 파일로 바뀌어 dotfiles 사본이 더는 갱신되지 않는다. realpath 로 실제
 *   파일을 찾아 그 폴더에서 tmp+rename 하므로 링크는 링크로 남고 대상 파일이 갱신된다.
 * - **원본 모드를 지킨다**: 이 파일들엔 API 키·다른 MCP 서버의 env 가 들어 있어 사용자가
 *   0600 으로 잠가두는 일이 흔하다. 기본 모드로 쓰면 umask 022 에서 0644(전체 읽기)로 넓어진다.
 *   `writeFileSync` 의 mode 옵션은 umask 에 깎이므로 `chmodSync` 로 한 번 더 못박는다.
 *   대상이 아직 없으면(같은 실행에서 방금 만든 JSON) 0600 으로 시작한다.
 */
function writeFileAtomic(env, path, content) {
  const fs = env.fs;
  let target = path;
  let mode = FRESH_FILE_MODE;
  let exists = false;
  try {
    exists = fs.existsSync(path);
  } catch {
    exists = false;
  }
  if (exists) {
    // realpath 가 없는 주입 fs(테스트) 나 경합으로 사라진 파일은 원래 경로 그대로 쓴다.
    try {
      target = fs.realpathSync ? fs.realpathSync(path) : path;
    } catch {
      target = path;
    }
    try {
      mode = fs.statSync(target).mode & 0o777;
    } catch {
      mode = FRESH_FILE_MODE;
    }
  }
  if (exists) {
    fs.copyFileSync(target, `${target}.bak`);
    // 이미 있던 `.bak` 은 copyFileSync 가 모드를 물려받지 않으므로 직접 맞춘다.
    chmodQuiet(fs, `${target}.bak`, mode);
  }
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  chmodQuiet(fs, tmp, mode);
  fs.renameSync(tmp, target);
}

/** chmod 을 못 쓰는 파일시스템(일부 Windows 공유)에서 쓰기 자체가 실패하면 안 된다. */
function chmodQuiet(fs, path, mode) {
  try {
    fs.chmodSync?.(path, mode);
  } catch {
    // 모드 고정 실패는 치명적이지 않다 — 내용은 이미 쓰였다
  }
}

export function writeJsonAtomic(env, path, doc) {
  writeFileAtomic(env, path, JSON.stringify(doc, null, 2) + "\n");
}

/** CLI 가 자체 `mcp list/add` 를 제공하는 클라이언트 */
function cliClient({
  id,
  label,
  agent,
  command,
  list,
  add,
  remove,
  hint,
  afterAdd,
  afterRemove,
  statusOverride,
}) {
  const cmd = () => (typeof command === "function" ? command() : command);
  return {
    id,
    label,
    agent,
    kind: "cli",
    detect(env) {
      try {
        const out = env
          .exec(cmd(), ["--version"], { stdio: "pipe" })
          .toString()
          .trim();
        return { installed: true, detail: out.split("\n")[0] };
      } catch {
        return { installed: false };
      }
    },
    status(env) {
      // 스코프 인식이 필요한 클라이언트(claude-code)는 statusOverride 가 먼저 판정하고,
      // null 을 돌려줄 때만(파일 없음 이외의 이유로 못 읽을 때) 기존 `mcp list` 판정으로 폴백한다.
      if (statusOverride) {
        const overridden = statusOverride(env);
        if (overridden != null) return overridden;
      }
      try {
        const out = env.exec(cmd(), list, { stdio: "pipe" }).toString();
        return out.includes("pluriply") ? "present" : "missing";
      } catch (err) {
        return { error: err.message };
      }
    },
    register(env) {
      if (isSkipped(env)) return "skipped";
      const st = this.status(env);
      if (st === "present") return "present";
      if (typeof st === "object") {
        env.log(
          `hint: make sure ${label} has pluriply registered: ${hint(env.binPath)}`,
        );
        return "failed";
      }
      try {
        env.exec(cmd(), add(env.node, env.binPath), { stdio: "pipe" });
      } catch {
        env.log(
          `hint: make sure ${label} has pluriply registered: ${hint(env.binPath)}`,
        );
        return "failed";
      }
      if (afterAdd) {
        const r = afterAdd(env);
        if (!r.ok) {
          // 타임아웃을 못 쓰면 등록을 되돌려 missing 으로 남긴다(스펙 D4). registered 는 항상 완전한 상태다.
          let rolledBack = true;
          try {
            env.exec(cmd(), remove, { stdio: "pipe" });
          } catch {
            // 되돌리기 자체가 실패하면 등록이 타임아웃 없이 남는다 — 메시지로 분명히 알린다
            rolledBack = false;
          }
          env.log(
            rolledBack
              ? `could not configure ${label}: ${r.reason}`
              : `could not configure ${label}: ${r.reason} (registration left in place; run "pluriply setup --remove")`,
          );
          return `failed: ${r.reason}`;
        }
      }
      env.log(`registered pluriply MCP server in ${label}`);
      return "registered";
    },
    unregister(env) {
      if (isSkipped(env)) return "skipped";
      const st = this.status(env);
      if (st === "missing") return "absent";
      if (typeof st === "object") {
        env.log(`cannot check ${label}: ${st.error}`);
        return "failed";
      }
      try {
        env.exec(cmd(), remove, { stdio: "pipe" });
      } catch {
        env.log(
          `hint: remove pluriply from ${label} manually: ${cmd()} ${remove.join(" ")}`,
        );
        return "failed";
      }
      if (afterRemove) {
        try {
          afterRemove(env);
        } catch (err) {
          env.log(
            `hint: pluriply was removed from ${label} but leftover config could not be cleaned: ${err.message}`,
          );
          return "failed";
        }
      }
      env.log(`removed pluriply MCP server from ${label}`);
      return "removed";
    },
  };
}

/** `mcpServers` JSON 설정 파일을 쓰는 데스크톱 앱 */
function jsonClient({ id, label, agent, entryExtras = {} }) {
  const file = (env) => configPath(id, env);
  const read = (env) => readJsonDoc(env, file(env));
  return {
    id,
    label,
    agent,
    kind: "config",
    detect(env) {
      return env.fs.existsSync(file(env))
        ? { installed: true, detail: file(env) }
        : { installed: false };
    },
    status(env) {
      try {
        return read(env).mcpServers?.pluriply ? "present" : "missing";
      } catch (err) {
        return { error: `${file(env)}: ${err.message}` };
      }
    },
    register(env) {
      if (isSkipped(env)) return "skipped";
      const st = this.status(env);
      if (st === "present") return "present";
      if (typeof st === "object") {
        // 손상된 설정은 덮어쓰지 않는다
        env.log(`cannot update ${label} config: ${st.error}`);
        return "failed";
      }
      const path = file(env);
      const doc = read(env);
      doc.mcpServers = {
        ...(doc.mcpServers ?? {}),
        pluriply: {
          command: env.node,
          args: [env.binPath, "connector", "--agent", agent],
          ...entryExtras,
        },
      };
      writeJsonAtomic(env, path, doc);
      env.log(
        `registered pluriply MCP server in ${label} (${path}, backup ${path}.bak)`,
      );
      return "registered";
    },
    unregister(env) {
      if (isSkipped(env)) return "skipped";
      const st = this.status(env);
      if (st === "missing") return "absent";
      if (typeof st === "object") {
        env.log(`cannot update ${label} config: ${st.error}`);
        return "failed";
      }
      const path = file(env);
      try {
        const doc = read(env);
        const { pluriply: _removed, ...rest } = doc.mcpServers ?? {};
        doc.mcpServers = rest;
        writeJsonAtomic(env, path, doc);
      } catch (err) {
        env.log(`cannot update ${label} config: ${err.message}`);
        return "failed";
      }
      env.log(
        `removed pluriply MCP server from ${label} (${path}, backup ${path}.bak)`,
      );
      return "removed";
    },
  };
}

export const CLIENTS = [
  cliClient({
    id: "claude-code",
    label: "Claude Code",
    agent: "claude-code",
    command: "claude",
    list: ["mcp", "list"],
    add: (node, bin) => [
      "mcp",
      "add",
      "-s",
      "user",
      "pluriply",
      "--",
      node,
      bin,
      "connector",
      "--agent",
      "claude-code",
    ],
    hint: (bin) =>
      `claude mcp add -s user pluriply -- node "${bin}" connector --agent claude-code`,
    remove: ["mcp", "remove", "-s", "user", "pluriply"],
    statusOverride: claudeUserScopeStatus,
  }),
  cliClient({
    id: "codex",
    label: MCP_REGISTRARS.codex.label,
    agent: "codex",
    command: "codex",
    list: MCP_REGISTRARS.codex.list.slice(1),
    add: (node, bin) => MCP_REGISTRARS.codex.add(node, bin).slice(1),
    hint: MCP_REGISTRARS.codex.hint,
    remove: ["mcp", "remove", "pluriply"],
    // codex mcp add 는 타임아웃 플래그가 없어 config.toml 을 직접 편집한다(스펙 §5)
    afterAdd(env) {
      const path = codexConfigPath(env);
      try {
        if (!env.fs.existsSync(path))
          return {
            ok: false,
            reason: `tool_timeout_sec not written (${path} missing)`,
          };
        const r = insertTomlKey(
          env.fs.readFileSync(path, "utf8"),
          "mcp_servers.pluriply",
          "tool_timeout_sec",
          String(TOOL_TIMEOUT_SEC),
        );
        if (r.reason === "no-header")
          return {
            ok: false,
            reason: `tool_timeout_sec not written ([mcp_servers.pluriply] not found in ${path})`,
          };
        if (r.reason === "unsupported")
          return {
            ok: false,
            reason: `tool_timeout_sec not written (${path} contains triple-quoted strings; add \`tool_timeout_sec = ${TOOL_TIMEOUT_SEC}\` under [mcp_servers.pluriply] by hand)`,
          };
        if (r.changed) writeFileAtomic(env, path, r.text);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: `tool_timeout_sec not written (${err.message})`,
        };
      }
    },
    // codex mcp remove 가 하위 테이블([mcp_servers.pluriply.tools.*])을 남길 수 있어 마저 지운다
    afterRemove(env) {
      const path = codexConfigPath(env);
      if (!env.fs.existsSync(path)) return;
      const { text, removed, reason } = removeTomlSections(
        env.fs.readFileSync(path, "utf8"),
        "mcp_servers.pluriply",
      );
      if (reason === "unsupported") {
        env.log(
          `hint: ${path} contains triple-quoted strings; if any [mcp_servers.pluriply*] sections remain, remove them by hand`,
        );
        return;
      }
      if (removed > 0) writeFileAtomic(env, path, text);
    },
  }),
  cliClient({
    id: "antigravity",
    label: MCP_REGISTRARS.antigravity.label,
    agent: "antigravity",
    command: agyCommand,
    list: MCP_REGISTRARS.antigravity.list.slice(1),
    add: (node, bin) => MCP_REGISTRARS.antigravity.add(node, bin).slice(1),
    hint: MCP_REGISTRARS.antigravity.hint,
    remove: ["mcp", "remove", "pluriply"],
    // agy mcp add 도 타임아웃 플래그가 없다. agy 는 JSONC 를 읽지만 우리는 JSON.parse 만 쓴다(스펙 §11).
    afterAdd(env) {
      const path = agyConfigPath(env);
      try {
        const doc = readJsonDoc(env, path);
        const entry = doc.mcpServers?.pluriply;
        if (!entry || typeof entry !== "object")
          return {
            ok: false,
            reason: `timeoutSeconds not written (mcpServers.pluriply not found in ${path})`,
          };
        if (entry.timeoutSeconds === undefined) {
          entry.timeoutSeconds = TOOL_TIMEOUT_SEC;
          writeJsonAtomic(env, path, doc);
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: `timeoutSeconds not written (${err.message})`,
        };
      }
    },
  }),
  jsonClient({
    id: "claude-desktop",
    label: "Claude Desktop",
    agent: "claude-desktop",
  }),
  jsonClient({
    id: "antigravity-ide",
    label: "Antigravity IDE",
    agent: "antigravity-ide",
    entryExtras: { timeoutSeconds: TOOL_TIMEOUT_SEC },
  }),
];
