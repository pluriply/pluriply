import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { agyCommand } from "../shared/agy.js";
import { MCP_REGISTRARS } from "../shared/mcp-register.js";

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
    fs: { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync },
    ...o,
  };
}

/** 테스트용 스킵 변수(구형 PLURIPLY_SKIP_CODEX_MCP 도 인정) */
function skipped(env) {
  return Boolean(
    env.processEnv.PLURIPLY_SKIP_MCP_REGISTER ||
      env.processEnv.PLURIPLY_SKIP_CODEX_MCP,
  );
}

/**
 * @param {"claude-desktop"|"antigravity-ide"} id
 * Antigravity 는 2.x 부터 IDE(`~/.gemini/antigravity-ide`) 와 허브(`~/.gemini/antigravity`) 로
 * 데이터 폴더가 갈라졌다. IDE 폴더가 있으면 그쪽, 없으면(구버전) 옛 경로.
 */
export function configPath(id, { homeDir, platform, processEnv = {}, fs = { existsSync } }) {
  if (id === "antigravity-ide") {
    const ideDir = join(homeDir, ".gemini", "antigravity-ide");
    const dir = fs.existsSync(ideDir) ? ideDir : join(homeDir, ".gemini", "antigravity");
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

/** CLI 가 자체 `mcp list/add` 를 제공하는 클라이언트 */
function cliClient({ id, label, agent, command, list, add, hint }) {
  const cmd = () => (typeof command === "function" ? command() : command);
  return {
    id,
    label,
    agent,
    kind: "cli",
    detect(env) {
      try {
        const out = env.exec(cmd(), ["--version"], { stdio: "pipe" })
          .toString()
          .trim();
        return { installed: true, detail: out.split("\n")[0] };
      } catch {
        return { installed: false };
      }
    },
    status(env) {
      try {
        const out = env.exec(cmd(), list, { stdio: "pipe" }).toString();
        return out.includes("pluriply") ? "present" : "missing";
      } catch (err) {
        return { error: err.message };
      }
    },
    register(env) {
      if (skipped(env)) return "skipped";
      const st = this.status(env);
      if (st === "present") return "present";
      if (typeof st === "object") {
        env.log(`hint: make sure ${label} has pluriply registered: ${hint(env.binPath)}`);
        return "failed";
      }
      try {
        env.exec(cmd(), add(env.node, env.binPath), { stdio: "pipe" });
        env.log(`registered pluriply MCP server in ${label}`);
        return "registered";
      } catch {
        env.log(`hint: make sure ${label} has pluriply registered: ${hint(env.binPath)}`);
        return "failed";
      }
    },
  };
}

/** `mcpServers` JSON 설정 파일을 쓰는 데스크톱 앱 */
function jsonClient({ id, label, agent }) {
  const file = (env) => configPath(id, env);
  const read = (env) => {
    const raw = env.fs.readFileSync(file(env), "utf8");
    if (raw.trim() === "") return { mcpServers: {} };
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== "object" || Array.isArray(doc))
      throw new Error("config root is not an object");
    return doc;
  };
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
      if (skipped(env)) return "skipped";
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
        },
      };
      env.fs.copyFileSync(path, `${path}.bak`);
      const tmp = `${path}.${process.pid}.tmp`;
      env.fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
      env.fs.renameSync(tmp, path);
      env.log(`registered pluriply MCP server in ${label} (${path}, backup ${path}.bak)`);
      return "registered";
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
      "mcp", "add", "-s", "user", "pluriply", "--", node, bin, "connector", "--agent", "claude-code",
    ],
    hint: (bin) => `claude mcp add -s user pluriply -- node "${bin}" connector --agent claude-code`,
  }),
  cliClient({
    id: "codex",
    label: MCP_REGISTRARS.codex.label,
    agent: "codex",
    command: "codex",
    list: MCP_REGISTRARS.codex.list.slice(1),
    add: (node, bin) => MCP_REGISTRARS.codex.add(node, bin).slice(1),
    hint: MCP_REGISTRARS.codex.hint,
  }),
  cliClient({
    id: "antigravity",
    label: MCP_REGISTRARS.antigravity.label,
    agent: "antigravity",
    command: agyCommand,
    list: MCP_REGISTRARS.antigravity.list.slice(1),
    add: (node, bin) => MCP_REGISTRARS.antigravity.add(node, bin).slice(1),
    hint: MCP_REGISTRARS.antigravity.hint,
  }),
  jsonClient({ id: "claude-desktop", label: "Claude Desktop", agent: "claude-desktop" }),
  jsonClient({ id: "antigravity-ide", label: "Antigravity IDE", agent: "antigravity-ide" }),
];
