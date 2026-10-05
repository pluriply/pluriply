// 사용: node fake-stdin-worker.js <ok|exit> <taskId> <home>
// Plan 6f: 내장 codex·claude-code 처럼 프롬프트를 표준 입력으로 받는 가짜 워커. 받은 표준 입력을
// <home>/workers/<taskId>.stdin 에 남기고, 채널은 인자가 아니라 허브가 넘긴 PLURIPLY_WORKER_CHANNEL 로 참여한다.
// exit: 표준 입력을 읽지 않고 곧바로 끝난다.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubClient } from "../../src/connector/hub-client.js";

const [behavior, taskId, home] = process.argv.slice(2);
if (behavior === "exit") process.exit(3);

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
writeFileSync(join(home, "workers", `${taskId}.stdin`), input);

const channelCode = process.env.PLURIPLY_WORKER_CHANNEL;
const hub = await HubClient.connect({ home });
await hub.request("agent.hello", {
  tool: process.env.PLURIPLY_WORKER_AGENT ?? "codex",
  cwd: process.cwd(),
  worker: true,
});
await hub.request("channel.join", { channelCode });
await hub.request("task.claim", { channelCode, taskId });
await hub.request("task.complete", {
  channelCode,
  taskId,
  result: `stdin ${input.length} chars, channel ${channelCode}`,
});
hub.close();
