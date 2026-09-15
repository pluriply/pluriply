// 사용: node fake-worker.js <ok|exit|hang|delegate|review> <taskId> <channelCode> <home>
// 실제 커넥터 클라이언트로 허브에 붙어 워커처럼 행동한다.
import { HubClient } from "../../src/connector/hub-client.js";

const [behavior, taskId, channelCode, home] = process.argv.slice(2);
const agent = process.env.PLURIPLY_WORKER_AGENT ?? "codex";

// 워커가 실제로 받은 프롬프트(요청자 등)를 로그(=워커 stdout)에 남긴다:
// test/hub/workers.test.js가 워커 명령에 프롬프트를 마지막 인자로 넣어준다.
console.log(process.argv.slice(2).join(" "));
console.log(`cwd=${process.cwd()}`);

if (process.env.PLURIPLY_FAKE_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}
const hub = await HubClient.connect({ home });
await hub.request("agent.hello", {
  tool: agent,
  cwd: process.cwd(),
  worker: true,
});
await hub.request("channel.join", { channelCode });

if (behavior === "hang") {
  setInterval(() => {}, 1000);
} else {
  await hub.request("task.claim", { channelCode, taskId });
  let result = `done by fake ${agent} in ${process.cwd()}`;
  if (behavior === "delegate") {
    try {
      const r = await hub.request("task.create", {
        channelCode,
        to: "claude-code",
        request: "sub-task",
        depth: Number(process.env.PLURIPLY_DEPTH ?? 0) + 1,
      });
      result = `delegated ${r.taskId} dispatch=${r.dispatch}`;
    } catch (err) {
      result = `delegate refused: ${err.message}`;
    }
  }
  if (behavior === "exit") {
    console.log("about to die");
    process.exit(3);
  }
if (behavior === "review") {
  await hub.request("task.complete", {
    channelCode,
    taskId,
    status: "completed",
    review: {
      verdict: "approve",
      findings: [{ severity: "minor", file: "a.js", line: 1, message: "nit" }],
      summary: `reviewed by fake ${agent}`,
    },
  });
  hub.close();
  process.exit(0);
}
  await hub.request("task.complete", {
    channelCode,
    taskId,
    result,
  });
  hub.close();
}
