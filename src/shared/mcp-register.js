import { execFileSync } from "node:child_process";
import { agyCommand } from "./agy.js";

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
 * `pluriply worker enable <agent>` 가 부른다. 실패해도 던지지 않는다(enable 자체는 성공).
 * @param {string} agent
 * @param {{binPath: string, exec?: typeof execFileSync, log?: (msg: string) => void, env?: NodeJS.ProcessEnv}} deps
 * @returns {"registered"|"present"|"skipped"|"failed"|"none"}
 */
export function registerMcpServer(
  agent,
  { binPath, exec = execFileSync, log = console.log, env = process.env },
) {
  const r = MCP_REGISTRARS[agent];
  if (!r) return "none";
  // PLURIPLY_SKIP_CODEX_MCP 는 Plan 2c 때 이름이라 호환으로 남긴다.
  if (env.PLURIPLY_SKIP_MCP_REGISTER || env.PLURIPLY_SKIP_CODEX_MCP)
    return "skipped";
  try {
    const [cmd, ...args] = r.list;
    const list = exec(cmd, args, { stdio: "pipe" }).toString();
    if (list.includes("pluriply")) return "present";
    const [addCmd, ...addArgs] = r.add(process.execPath, binPath);
    exec(addCmd, addArgs, { stdio: "pipe" });
    log(`registered pluriply MCP server in ${r.label}`);
    return "registered";
  } catch {
    log(
      `hint: make sure ${r.label} has pluriply registered: ${r.hint(binPath)}`,
    );
    return "failed";
  }
}
