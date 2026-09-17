#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  Hub,
  stopHub,
  spawnHub,
  readLock,
  loadConfig,
  setWorkerEnabled,
  TEMPLATE_AGENTS,
} from "../src/hub/index.js";
import { pluriplyHome } from "../src/shared/paths.js";
import { pingHub, pidAlive } from "../src/shared/probe.js";
import { connectIfLive } from "../src/connector/hub-client.js";
import { isValidAgentName } from "../src/shared/identity.js";
import { registerMcpServer } from "../src/shared/mcp-register.js";

const BIN_PATH = fileURLToPath(import.meta.url);

const [cmd, ...rest] = process.argv.slice(2);
const sub = rest[0];

/**
 * `--agent x` 와 `--agent=x` 둘 다 파싱한다. 값이 없거나(마지막 토큰) 뒤 토큰이 `--`로 시작하면
 * (다음 플래그를 값으로 삼켜버린 것) 조용히 undefined 를 돌려주지 않고 즉시 사용법 오류로
 * 종료한다 — 그렇지 않으면 `setup --remove --purge --only`(값 없이 끝남)나
 * `setup --remove --purge --only=codex`(`=` 형을 못 읽어 undefined)처럼 스코프를 좁히는 플래그가
 * 조용히 무시되어 의도보다 넓은 범위(--purge 전체 삭제)가 exit 0 으로 실행된다.
 */
function flag(name) {
  const i = rest.findIndex(
    (t) => t === `--${name}` || t.startsWith(`--${name}=`),
  );
  if (i === -1) return undefined;
  const inline = rest[i].startsWith(`--${name}=`);
  const v = inline ? rest[i].slice(name.length + 3) : rest[i + 1];
  if (v === undefined || v === "" || (!inline && v.startsWith("--"))) {
    console.error(`missing value for --${name}`);
    process.exit(1);
  }
  return v;
}

/** setup 이 아는 플래그. 오타 하나가 파괴적인 명령의 범위를 넓히지 못하게 한다. */
const SETUP_BOOL_FLAGS = [
  "workers",
  "dry-run",
  "remove",
  "purge",
  "no-hooks",
  "hooks-only",
];
const SETUP_VALUE_FLAGS = ["only"];

if (cmd === "hub" && sub === "start") {
  try {
    const hub = new Hub();
    const { port, redundant } = await hub.start();
    if (redundant) {
      console.log(`pluriply hub already running on ${port}`);
      process.exit(0);
    }
    console.log(`pluriply hub listening on ${port}`);
    const shutdown = async () => {
      await hub.stop();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (err) {
    console.error(`failed to start hub: ${err.message}`);
    process.exit(1);
  }
} else if (cmd === "hub" && sub === "stop") {
  const home = pluriplyHome();
  const result = await stopHub({ home });
  if (result === "not-running") console.log("not running");
  else if (result === "stopped") console.log("hub stopped");
  else {
    const lock = readLock(home);
    console.error(`hub did not stop within 5s (pid ${lock?.pid ?? "unknown"})`);
    process.exit(1);
  }
} else if (cmd === "hub" && sub === "restart") {
  const home = pluriplyHome();
  try {
    const stopped = await stopHub({ home });
    if (stopped === "timeout") {
      console.error("hub did not stop within 5s; not restarting");
      process.exit(1);
    }
    const live = await spawnHub({ home });
    console.log(`pluriply hub restarted on ${live.port}`);
  } catch (err) {
    console.error(`failed to restart hub: ${err.message}`);
    process.exit(1);
  }
} else if (cmd === "worker") {
  const home = pluriplyHome();
  const agent = rest[1];
  if (sub === "list") {
    const cfg = loadConfig(home);
    // 살아 있는 허브에만 붙는다: 새로 띄우지 않는다. 전역 실행 중 워커 수는
    // worker.status(payload {})로 물어보며, 허브가 없거나 질의가 실패/타임아웃되면
    // 접미사 없이 조용히 넘어간다. 소켓은 받아들이지만 응답을 안 하는 허브에
    // 무한정 매달리지 않도록 명시적 타임아웃을 둔다(연결 자체의 타임아웃과 별개).
    let running = null;
    const client = await connectIfLive({ home });
    if (client) {
      try {
        ({ running } = await client.request(
          "worker.status",
          {},
          { timeoutMs: 3000 },
        ));
      } catch {
        running = null;
      } finally {
        client.close();
      }
    }
    for (const a of TEMPLATE_AGENTS) {
      const enabled = Boolean(cfg.workers[a]?.enabled);
      const suffix = enabled && running ? ` (${running} running)` : "";
      console.log(`${a}: ${enabled ? "enabled" : "disabled"}${suffix}`);
    }
  } else if ((sub === "enable" || sub === "disable") && agent) {
    if (!TEMPLATE_AGENTS.includes(agent)) {
      console.error(`no worker template for "${agent}"`);
      process.exit(1);
    }
    setWorkerEnabled(home, [agent], sub === "enable");
    if (sub === "enable") registerMcpServer(agent, { binPath: BIN_PATH });
    console.log(`worker ${agent} ${sub}d`);
  } else {
    console.error(
      "usage: pluriply worker <enable|disable> <agent> | worker list",
    );
    process.exit(1);
  }
} else if (cmd === "setup") {
  const { runSetup, formatSetup } = await import("../src/setup/run-setup.js");
  const { makeEnv } = await import("../src/setup/clients.js");
  const usage = (msg) => {
    console.error(`setup: ${msg}`);
    process.exit(1);
  };
  // `--only a,b` 처럼 값 플래그 바로 뒤에 오는 토큰만 대시 없는 인자로 허용한다.
  const valueSlots = new Set();
  rest.forEach((tok, i) => {
    if (!tok.startsWith("--") || tok.includes("=")) return;
    if (SETUP_VALUE_FLAGS.includes(tok.slice(2))) valueSlots.add(i + 1);
  });
  // 모르는 플래그는 아무것도 실행하기 전에 거부한다: `--pruge` 같은 오타가 조용히 무시되면
  // `--remove --pruge` 가 "그냥 제거"로 통과하고, 반대로 좁히려던 플래그의 오타는 범위를 넓힌다.
  // 대시 없는 토큰도 마찬가지다 — `pluriply setup remove` 는 지금까지 조용히 "등록"을 실행했다.
  for (const [i, tok] of rest.entries()) {
    if (!tok.startsWith("--")) {
      if (!valueSlots.has(i)) usage(`unexpected argument "${tok}"`);
      continue;
    }
    const nm = tok.slice(2).split("=")[0];
    if (SETUP_BOOL_FLAGS.includes(nm)) {
      // `--dry-run=false` 처럼 값을 붙이면 지금까지는 토큰 자체가 안 맞아 조용히 무시됐다.
      if (tok.includes("=")) usage(`--${nm} takes no value`);
    } else if (!SETUP_VALUE_FLAGS.includes(nm)) usage(`unknown flag --${nm}`);
  }
  const onlyArg = flag("only");
  const workers = rest.includes("--workers");
  const dryRun = rest.includes("--dry-run");
  const remove = rest.includes("--remove");
  const purge = rest.includes("--purge");
  const hooks = !rest.includes("--no-hooks");
  const hooksOnly = rest.includes("--hooks-only");
  if (remove && workers) usage("--remove cannot be combined with --workers");
  if (purge && !remove) usage("--purge requires --remove");
  if (purge && onlyArg) usage("--purge cannot be combined with --only");
  if (remove && !hooks) usage("--no-hooks has no effect with --remove");
  // --hooks-only 는 MCP 등록·워커·허브를 건드리지 않는다(스펙 §4.1). 그것들을 겨냥한 플래그와는 모순.
  if (hooksOnly && workers)
    usage("--hooks-only cannot be combined with --workers");
  if (hooksOnly && !hooks)
    usage("--hooks-only cannot be combined with --no-hooks");
  if (hooksOnly && purge) usage("--hooks-only cannot be combined with --purge");
  try {
    const r = await runSetup({
      only: onlyArg
        ? onlyArg
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : undefined,
      workers,
      dryRun,
      remove,
      purge,
      hooks,
      hooksOnly,
      env: makeEnv({ binPath: BIN_PATH }),
      home: pluriplyHome(),
    });
    if (dryRun) console.log("(dry run — nothing was changed)");
    for (const line of formatSetup(r, { workers })) console.log(line);
    if (r.failed > 0) process.exit(1);
  } catch (err) {
    console.error(`setup failed: ${err.message}`);
    process.exit(1);
  }
} else if (cmd === "status") {
  const home = pluriplyHome();
  const lock = readLock(home);
  if (!lock) {
    console.log("not running");
  } else {
    const info = await pingHub(lock.port);
    if (info) {
      console.log(
        `running (port ${lock.port}, pid ${info.pid ?? lock.pid}, version ${info.version ?? "unknown"}, protocol ${info.protocol ?? 1})`,
      );
    } else if (!pidAlive(lock.pid)) {
      // Windows 에서는 SIGTERM 이 정리 핸들러 없이 즉시 종료라 허브가 락을 못 지운다.
      // pid 가 죽었으면 stopHub 와 같은 판정으로 락을 지우고 not running 으로 본다.
      // 단, pingHub 가 기다리는 동안 hub start 가 새 락을 썼을 수 있으니 다시 읽어
      // pid 가 그대로일 때만 지운다(남의 새 락을 지우지 않기 위해).
      const current = readLock(home);
      if (current?.pid === lock.pid) {
        rmSync(join(home, "hub.json"), { force: true });
      }
      console.log("not running");
    } else {
      console.log(`stale lockfile (pid ${lock.pid} not responding)`);
    }
  }
} else if (cmd === "hook" && sub === "stop") {
  // Stop 훅(스펙 §3). 어떤 경우에도 JSON 한 줄 + exit 0. 늦게 열린 소켓이 프로세스를 잡아두지
  // 않도록 출력 뒤 바로 종료한다.
  const { runStopHook } = await import("../src/setup/hook-stop.js");
  // 기존 flag()는 값이 없거나 모양이 이상하면(마지막 토큰, `--agent=`, 다음 플래그를
  // 값으로 삼키려는 모양) exit(1)을 부르는데, 훅은 무슨 입력이 와도 항상 exit 0이어야
  // 한다 — flag()를 쓰지 않고 여기서 직접 파싱해, 못 읽으면 그냥 undefined로 둔다
  // (runStopHook이 알 수 없는/undefined agent를 {}로 처리한다).
  let agent;
  const ai = rest.findIndex((t) => t === "--agent" || t.startsWith("--agent="));
  if (ai !== -1) {
    if (rest[ai].startsWith("--agent=")) {
      const v = rest[ai].slice("--agent=".length);
      agent = v === "" ? undefined : v;
    } else {
      const v = rest[ai + 1];
      agent = v === undefined || v.startsWith("--") ? undefined : v;
    }
  }
  let input = "";
  if (!process.stdin.isTTY) {
    try {
      for await (const chunk of process.stdin) input += chunk;
    } catch {
      input = "";
    }
  }
  let out = {};
  try {
    out = await runStopHook({ agent, input, home: pluriplyHome() });
  } catch {
    out = {};
  }
  // 출력 뒤 바로 종료한다: 늦게 열린 소켓이 프로세스를 잡아두지 않게 한다. write()의
  // 콜백을 기다려 스트림이 비동기 파이프인 플랫폼(Windows)에서 출력이 잘리지 않게 하고,
  // 그 콜백이 오지 않는 경우를 대비해 폴백 타이머도 둔다(타이머 자체가 프로세스를
  // 붙잡지 않도록 unref).
  process.stdout.write(JSON.stringify(out) + "\n", () => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref?.();
} else if (cmd === "connector") {
  const agent = flag("agent");
  if (!agent) {
    console.error("usage: pluriply connector --agent <name>");
    process.exit(1);
  }
  if (!isValidAgentName(agent)) {
    console.error(`invalid agent name: ${agent}`);
    process.exit(1);
  }
  const { startConnector } = await import("../src/connector/mcp-server.js");
  await startConnector({ agent });
} else {
  console.error(
    "usage: pluriply <setup [--workers] [--dry-run] [--only a,b] [--no-hooks|--hooks-only]|setup --remove [--purge] [--dry-run] [--only a,b] [--hooks-only]|hub start|hub stop|hub restart|hook stop --agent <claude-code|codex|antigravity>|connector --agent <name>|status|worker enable|disable <codex|claude-code|antigravity>|worker list>",
  );
  process.exit(1);
}
