import { execFileSync } from "node:child_process";
import { CLIENTS, MCP_REGISTRARS, makeEnv } from "../setup/clients.js";

/** 등록 명령표는 src/setup/clients.js 로 옮겼다. 기존 import 경로를 위해 재수출한다. */
export { MCP_REGISTRARS };

/**
 * `pluriply worker enable <agent>` 가 부른다. 실패해도 던지지 않는다(enable 자체는 성공).
 * 실제 등록(타임아웃 쓰기 포함)은 `pluriply setup` 과 같은 어댑터가 한다. claude-code 는 워커
 * 템플릿이 --mcp-config 로 인라인 등록하므로 여기서는 "none".
 * @param {string} agent
 * @param {{binPath: string, exec?: typeof execFileSync, log?: (msg: string) => void, env?: NodeJS.ProcessEnv, homeDir?: string}} deps
 * @returns {"registered"|"present"|"skipped"|"failed"|"none"}
 */
export function registerMcpServer(
  agent,
  {
    binPath,
    exec = execFileSync,
    log = console.log,
    env = process.env,
    homeDir,
  },
) {
  if (!MCP_REGISTRARS[agent]) return "none";
  const client = CLIENTS.find((c) => c.agent === agent);
  const r = client.register(
    makeEnv({
      binPath,
      exec,
      log,
      processEnv: env,
      ...(homeDir ? { homeDir } : {}),
    }),
  );
  return r.startsWith("failed") ? "failed" : r;
}
