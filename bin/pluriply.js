#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Hub,
  stopHub,
  spawnHub,
  readLock,
  loadConfig,
  saveConfig,
  TEMPLATE_AGENTS,
} from "../src/hub/index.js";
import { pluriplyHome } from "../src/shared/paths.js";
import { pingHub } from "../src/shared/probe.js";
import { connectIfLive } from "../src/connector/hub-client.js";
import { isValidAgentName } from "../src/shared/identity.js";
import { registerMcpServer } from "../src/shared/mcp-register.js";

const BIN_PATH = fileURLToPath(import.meta.url);

const [cmd, ...rest] = process.argv.slice(2);
const sub = rest[0];

/** --agent x 같은 플래그 파싱 */
function flag(name) {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
}

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
    const cfg = loadConfig(home);
    const workers = { ...cfg.workers };
    if (sub === "enable")
      workers[agent] = { ...(workers[agent] ?? {}), enabled: true };
    else delete workers[agent];
    // 원본 config.json 문서를 그대로 보존한 채 workers만 갱신한다: loadConfig가
    // 돌려주는 cfg는 allowedRoots·limits를 기본값으로 채워 넣은 파생값이라, 그걸
    // 그대로 다시 쓰면 사용자가 직접 넣은 allowedRoots(Task 1의 cwd 경계 설정)나
    // 손대지 않은 다른 키가 사라진다. 파일을 다시 읽어 병합한다(없거나 손상돼도 {}).
    const file = join(home, "config.json");
    let rawDoc = {};
    if (existsSync(file)) {
      try {
        rawDoc = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        rawDoc = {};
      }
    }
    if (!rawDoc || typeof rawDoc !== "object" || Array.isArray(rawDoc))
      rawDoc = {};
    saveConfig(home, { ...rawDoc, workers });
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
  const onlyArg = flag("only");
  const workers = rest.includes("--workers");
  const dryRun = rest.includes("--dry-run");
  try {
    const r = await runSetup({
      only: onlyArg ? onlyArg.split(",").map((x) => x.trim()).filter(Boolean) : undefined,
      workers,
      dryRun,
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
  const lock = readLock(pluriplyHome());
  if (!lock) {
    console.log("not running");
  } else {
    const info = await pingHub(lock.port);
    if (!info) {
      console.log(`stale lockfile (pid ${lock.pid} not responding)`);
    } else {
      console.log(
        `running (port ${lock.port}, pid ${info.pid ?? lock.pid}, version ${info.version ?? "unknown"}, protocol ${info.protocol ?? 1})`,
      );
    }
  }
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
    "usage: pluriply <setup [--workers] [--dry-run] [--only a,b]|hub start|hub stop|hub restart|connector --agent <name>|status|worker enable|disable <codex|claude-code|antigravity>|worker list>",
  );
  process.exit(1);
}
