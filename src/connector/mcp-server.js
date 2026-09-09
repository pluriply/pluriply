import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isValidAgentName, resolveAgentName } from "../shared/identity.js";
import { HubClient } from "./hub-client.js";
import { registerTools, hello } from "./tools.js";

/**
 * 허브 접속·정체성 확인·도구 등록까지 수행한다(stdio 연결은 하지 않는다 —
 * 테스트가 StdioServerTransport 없이 재사용할 수 있도록 분리).
 * @param {{agent: string, home?: string}} opts
 * @returns {Promise<{hub: import('./hub-client.js').HubClient, instanceId: string|null, server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer}>}
 */
export async function buildConnector({ agent, home }) {
  const hub = await HubClient.connect({ home });
  // 구형 허브에는 agent.hello가 없다. 여기서 죽지 말고(unknown message type로
  // 던지지 말고) 도구가 첫 호출마다 재시작 안내를 내게 둔다(tools.js:72, 131).
  const instanceId = hub.stale
    ? null
    : await hello(hub, {
        agent,
        worker: Boolean(process.env.PLURIPLY_WORKER_TASK),
      });
  const server = new McpServer({ name: "pluriply", version: "0.1.0" });
  registerTools(server, hub, { agent, instanceId });
  return { hub, instanceId, server };
}

/** stdio MCP 커넥터를 시작한다. AI 도구가 이 프로세스를 MCP 서버로 실행한다. */
export async function startConnector({ agent, home }) {
  if (!isValidAgentName(agent)) {
    console.error(`invalid agent name: ${agent}`);
    process.exit(1);
  }
  const resolved = resolveAgentName(agent, process.env);
  if (resolved !== agent) console.error(`pluriply: --agent ${agent} launched by Antigravity IDE, joining as ${resolved}`);
  const { hub, server } = await buildConnector({ agent: resolved, home });
  await server.connect(new StdioServerTransport());
  // AI 도구(부모)가 죽거나 MCP 서버를 내리면 stdin 이 닫힌다. 허브 WebSocket 이 이벤트 루프를
  // 붙잡고 있어 그대로 두면 커넥터가 고아로 남으므로(실측: 하루 넘게 살아남은 프로세스 다수),
  // stdin 종료 시 허브 연결을 닫고 곧바로 끝낸다.
  const shutdown = () => {
    try {
      hub.close();
    } catch {
      // 이미 닫힌 경우 등: 무시
    }
    process.exit(0);
  };
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
}
