#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
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
import { buildStatus, formatStatus } from "../src/shared/status-format.js";
import { VIEW_HINT_LINE, hasHint, markHint } from "../src/shared/hints.js";
import {
  TELEMETRY_NOTICE,
  printTelemetryNotice,
  disabledReason,
  readState,
  buildPayload,
  setEnabled,
  noteEnvOptOut,
} from "../src/shared/telemetry.js";
import { PACKAGE_VERSION } from "../src/shared/version.js";

const BIN_PATH = fileURLToPath(import.meta.url);

const [cmd, ...rest] = process.argv.slice(2);
const sub = rest[0];

// 환경 변수 끄기(PLURIPLY_TELEMETRY=0·DO_NOT_TRACK·CI)를 본 즉시 홈에 기억한다 — 이 셸 밖에서 뜬 허브
// (Codex·Dock 으로 띄운 도구가 띄운 허브)도 따르게. noteEnvOptOut 은 던지지 않지만 명령을 흔들지 않게 감싼다.
try {
  noteEnvOptOut(pluriplyHome());
} catch {
  // 무시
}

/**
 * 처음 안내를 "알렸다"고 기록해도 되는지: 사람이 보는 터미널일 때만. PLURIPLY_TELEMETRY_ASSUME_TTY=1 은
 * 테스트 전용(파이프로 받는 시험이 기록까지 확인하게) — 문서에는 적지 않는다.
 */
const humanSees = () =>
  process.stdout.isTTY === true ||
  process.env.PLURIPLY_TELEMETRY_ASSUME_TTY === "1";

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
    // Plan 4g: 락이 다른 허브로 넘어가면 허브가 스스로 물러난다(stop 완료 후 이 이벤트).
    hub.on("orphaned", () => {
      console.log("pluriply hub: lock taken by another hub; exiting");
      process.exit(0);
    });
    // 락 감시가 낸 stop() 과 겹칠 수 있다. stop() 이 거부돼도 unhandled rejection 으로
    // 죽지 않고 반드시 종료한다(Plan 4g).
    const shutdown = async () => {
      try {
        await hub.stop();
      } finally {
        process.exit(0);
      }
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
  else if (result === "unresponsive") {
    const lock = readLock(home);
    console.error(
      `hub is not answering (pid ${lock?.pid ?? "unknown"}); left it running. If no hub is running, \`pluriply hub start\` replaces the lock.`,
    );
    process.exit(1);
  } else {
    const lock = readLock(home);
    console.error(`hub did not stop within 5s (pid ${lock?.pid ?? "unknown"})`);
    process.exit(1);
  }
} else if (cmd === "hub" && sub === "restart") {
  const home = pluriplyHome();
  try {
    const stopped = await stopHub({ home });
    if (stopped === "timeout" || stopped === "unresponsive") {
      console.error(
        stopped === "timeout"
          ? "hub did not stop within 5s; not restarting"
          : "hub is not answering; not restarting",
      );
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
      // agy 워커는 기본으로 --sandbox(셸 불가) — 끈 경우만 표시한다
      const sandboxOff =
        enabled && a === "antigravity" && cfg.workers[a]?.sandbox === false
          ? " (sandbox off)"
          : "";
      console.log(
        `${a}: ${enabled ? "enabled" : "disabled"}${sandboxOff}${suffix}`,
      );
    }
  } else if ((sub === "enable" || sub === "disable") && agent) {
    if (!TEMPLATE_AGENTS.includes(agent)) {
      console.error(`no worker template for "${agent}"`);
      process.exit(1);
    }
    setWorkerEnabled(home, [agent], sub === "enable");
    if (sub === "enable") registerMcpServer(agent, { binPath: BIN_PATH });
    console.log(`worker ${agent} ${sub}d`);
    if (sub === "enable" && agent === "antigravity")
      console.log(
        "antigravity workers run with --sandbox: no shell commands (file edits outside the task folder are not blocked). " +
          `To allow shell commands, set "sandbox": false under workers.antigravity in ${join(home, "config.json")}.`,
      );
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
    if (!dryRun && !remove) {
      for (const line of printTelemetryNotice(pluriplyHome(), {
        mark: humanSees(),
      }))
        console.log(line);
    }
    if (r.failed > 0) process.exit(1);
  } catch (err) {
    console.error(`setup failed: ${err.message}`);
    process.exit(1);
  }
} else if (cmd === "status") {
  const json = rest.includes("--json");
  const home = pluriplyHome();
  const lock = readLock(home);
  // 안내는 사람용 출력 맨 끝에만(터미널일 때만 기록한다). --json 은 기록 없이 필드만 더한다.
  const notice = () => {
    if (json) return;
    for (const line of printTelemetryNotice(home, { mark: humanSees() }))
      console.log(line);
  };
  const out = (text, obj) =>
    console.log(
      json
        ? JSON.stringify(
            hasHint(home, "telemetry")
              ? obj
              : { ...obj, telemetryNotice: TELEMETRY_NOTICE },
            null,
            2,
          )
        : text,
    );
  if (!lock) {
    out("not running", { hub: { running: false } });
    if (!json) console.log(VIEW_HINT_LINE);
    notice();
  } else {
    const info = await pingHub(lock.port);
    if (info) {
      // Plan 6a: 세션 목록을 받아 옛 코드로 도는 허브·세션을 가린다. Plan 6c: 프로토콜 11 부터
      // (깨우기 상태·problems 가 함께 온다) — 더 옛 허브는 재시작 안내만 낸다.
      let sessions = null;
      let error = null;
      if ((info.protocol ?? 1) >= 11) {
        const client = await connectIfLive({ home });
        if (!client) error = "could not connect to the hub";
        else {
          try {
            sessions = await client.request(
              "hub.sessions",
              {},
              { timeoutMs: 3000 },
            );
          } catch (err) {
            error = err.message;
          } finally {
            client.close();
          }
        }
      }
      const st = buildStatus({
        ping: {
          port: lock.port,
          pid: info.pid ?? lock.pid,
          version: info.version,
          protocol: info.protocol ?? 1,
        },
        sessions,
        error,
        // Plan 6c D4: 자동 기동 허브의 로그(problems 절이 가리킨다)
        // src/hub/lifecycle.js 의 hubLogPath 와 같은 경로 — bin 은 허브를 공개 경계(index.js)로만 가져온다
        logFile: join(home, "logs", "hub.log"),
      });
      if (json) out("", st);
      else {
        for (const line of formatStatus(st, { home: homedir() }))
          console.log(line);
        notice();
      }
    } else if (!pidAlive(lock.pid)) {
      // Windows 에서는 SIGTERM 이 정리 핸들러 없이 즉시 종료라 허브가 락을 못 지운다.
      // pid 가 죽었으면 stopHub 와 같은 판정으로 락을 지우고 not running 으로 본다.
      // 단, pingHub 가 기다리는 동안 hub start 가 새 락을 썼을 수 있으니 다시 읽어
      // pid 가 그대로일 때만 지운다(남의 새 락을 지우지 않기 위해).
      const current = readLock(home);
      if (current?.pid === lock.pid) {
        rmSync(join(home, "hub.json"), { force: true });
      }
      out("not running", { hub: { running: false } });
      if (!json) console.log(VIEW_HINT_LINE);
      notice();
    } else {
      out(`stale lockfile (pid ${lock.pid} not responding)`, {
        hub: { running: false, stale: true, pid: lock.pid },
      });
      notice();
    }
  }
} else if (cmd === "telemetry") {
  const home = pluriplyHome();
  const arg = sub;
  const json = rest.includes("--json") || sub === "--json";
  if (arg === "on" || arg === "off") {
    setEnabled(home, arg === "on");
    // 직접 고른 사용자에게 처음 안내는 필요 없다
    markHint(home, "telemetry");
    if (json) {
      const reason = disabledReason({ home });
      console.log(JSON.stringify({ enabled: reason === null, reason }));
    } else console.log(`telemetry ${arg}`);
  } else if (arg === undefined || arg === "status" || arg === "--json") {
    // 보내지 않는다 — 보낼 내용을 만들어 보여 주기만 한다
    const reason = disabledReason({ home });
    const state = readState(home);
    const payload = buildPayload({ home, version: PACKAGE_VERSION });
    const lastSentAt = state.lastSentAt ?? null;
    if (json) {
      console.log(
        JSON.stringify(
          { enabled: reason === null, reason, lastSentAt, payload },
          null,
          2,
        ),
      );
    } else {
      console.log(
        reason === null ? "telemetry on" : `telemetry off (${reason})`,
      );
      if (["env", "do-not-track", "ci"].includes(reason))
        console.log(
          "remembered on this computer until: npx pluriply telemetry on",
        );
      console.log(`last sent ${lastSentAt ?? "never"}`);
      console.log("would send:");
      console.log(JSON.stringify(payload, null, 2));
    }
  } else {
    console.error("usage: pluriply telemetry [status [--json]|on|off]");
    process.exit(1);
  }
} else if (cmd === "view") {
  // 화면 서버(view 설계 §6.3). 서버·런처는 쓰는 순간에만 불러온다.
  const known = ["--no-open", "--json", "--serve"];
  const bad = rest.find((t) => t !== "stop" && !known.includes(t));
  if (bad !== undefined) {
    console.error(`unknown option: ${bad}`);
    process.exit(1);
  }
  const home = pluriplyHome();
  if (rest.includes("--serve")) {
    // 신호가 서버보다 먼저 와도 받도록 핸들러를 먼저 건다
    let server = null;
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      (server ? server.close("stopped") : Promise.resolve())
        .catch(() => {})
        .then(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    const { startViewServer, makeHubSessionsFetcher } =
      await import("../src/view/server.js");
    const fetcher = makeHubSessionsFetcher(home);
    if (stopping) process.exit(0);
    server = await startViewServer({
      home,
      fetchSessions: () => fetcher.fetch(),
    });
    server.closed.then(() => fetcher.close());
    if (stopping) shutdown();
    await server.closed;
    process.exit(0);
  } else if (rest.includes("stop")) {
    const { stopView } = await import("../src/shared/view-launch.js");
    const result = await stopView({ home });
    if (result === "stopped") console.log("view: stopped");
    else if (result === "not-running") console.log("view: not running");
    else if (result === "unresponsive") {
      const { readViewLock } = await import("../src/shared/view-lock.js");
      console.error(
        `view: not answering (pid ${readViewLock(home)?.pid ?? "unknown"}); left running`,
      );
      process.exit(1);
    } else {
      console.error("view: failed to stop within 5s");
      process.exit(1);
    }
  } else {
    const { ensureView } = await import("../src/shared/view-launch.js");
    try {
      const r = await ensureView({ home, open: !rest.includes("--no-open") });
      if (rest.includes("--json")) console.log(JSON.stringify(r));
      else {
        console.log(`Pluriply view: ${r.url}`);
        if (!r.opened) console.log("Open this address in your browser.");
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
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
} else if (cmd === "codex") {
  // Plan 5b: 깨울 수 있는 Codex 세션. 나머지 인자는 해석하지 않고 codex 에 그대로 넘긴다.
  const { runCodex } = await import("../src/launcher/codex.js");
  process.exit(await runCodex(rest));
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
    "usage: pluriply <setup [--workers] [--dry-run] [--only a,b] [--no-hooks|--hooks-only]|setup --remove [--purge] [--dry-run] [--only a,b] [--hooks-only]|hub start|hub stop|hub restart|hook stop --agent <claude-code|codex|antigravity>|codex [codex args…]|connector --agent <name>|status [--json]|telemetry [status [--json]|on|off]|view [--no-open] [--json]|view stop|worker enable|disable <codex|claude-code|antigravity>|worker list>",
  );
  process.exit(1);
}
