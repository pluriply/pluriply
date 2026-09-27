// 가짜 codex(실행기 테스트용). `app-server --listen unix://S` 면 S 에서 리슨하고, 아니면(TUI)
// 받은 인자·env 를 기록한 뒤 FAKE_CODEX_EXIT 코드로 끝난다.
import { createServer } from "node:net";
import { appendFileSync } from "node:fs";

const out = process.env.FAKE_CODEX_OUT;
const args = process.argv.slice(2);
const record = (role) =>
  appendFileSync(
    out,
    JSON.stringify({
      role,
      args,
      remote: process.env.PLURIPLY_CODEX_REMOTE ?? null,
      pid: process.pid,
    }) + "\n",
  );
if (args[0] === "app-server") {
  record("app");
  if (process.env.FAKE_CODEX_APP_FAIL === "1") process.exit(3);
  const sock = args[args.indexOf("--listen") + 1].slice("unix://".length);
  createServer().listen(sock);
  process.on("SIGTERM", () => process.exit(0));
} else {
  record("tui");
  process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0));
}
