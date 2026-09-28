// Plan 5b(스펙 §6.2): `pluriply codex` 로 띄운 Codex 세션을 codex queue 로 깨운다.
// 커넥터는 세션 전용 앱 서버 밑에서 뜨고, 실행기가 PLURIPLY_CODEX_REMOTE 로 소켓을 알려 준다.
import { execFile } from "node:child_process";
import { formatActivity } from "../shared/activity-format.js";

export const WAKE_CHUNK_MS = 15_000;
const THREAD = /^[A-Za-z0-9._:-]{1,128}$/;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {unknown} v @returns {string|null} */
export function validThreadId(v) {
  return typeof v === "string" && THREAD.test(v) ? v : null;
}

/**
 * Codex 는 MCP tools/call 마다 _meta 에 스레드 ID 를 싣는다(2026-09-27 실측).
 * @param {object|undefined} extra @returns {string|null}
 */
export function threadIdFromExtra(extra) {
  const meta = extra?._meta;
  return (
    validThreadId(meta?.threadId) ??
    validThreadId(meta?.["x-codex-turn-metadata"]?.thread_id)
  );
}

/**
 * 깨우기를 켤지: codex 대화형 커넥터가 `pluriply codex` 앱 서버 밑에서 떴고 허브가 새 프로토콜일 때.
 * @param {{agent: string, env?: NodeJS.ProcessEnv, stale?: object|null}} o @returns {boolean}
 */
export function codexWakeEnabled({ agent, env = process.env, stale }) {
  return (
    agent === "codex" &&
    typeof env.PLURIPLY_CODEX_REMOTE === "string" &&
    env.PLURIPLY_CODEX_REMOTE.startsWith("unix://") &&
    !env.PLURIPLY_WORKER_TASK &&
    !stale
  );
}

/**
 * `codex queue` 로 쉬는(또는 일하는) 스레드에 메시지를 넣는다 — 일하는 중이면 턴이 끝난 뒤 처리된다.
 * @param {{remote: string, threadId: string, message: string, bin?: string}} o @returns {Promise<void>}
 */
export function runCodexQueue({
  remote,
  threadId,
  message,
  bin = process.env.PLURIPLY_CODEX_BIN || "codex",
}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["queue", "--remote", remote, "--thread", threadId, "--message", message],
      { timeout: 10_000 },
      (err, _stdout, stderr) => {
        if (!err) return resolve();
        const last = String(stderr || err.message)
          .trim()
          .split("\n")
          .pop();
        reject(new Error(last || err.message));
      },
    );
  });
}

/**
 * 뒤에서 agent.wait 를 돌다가 활동이 오면 이 세션의 스레드를 깨운다. 스레드 ID 를 모르면
 * 허브가 아무것도 넘기지 않는다(requireThread) — 그동안은 Stop 훅이 턴 끝에 전달한다.
 * @param {{hubRequest: (type: string, payload?: object, opts?: object) => Promise<any>, state: {threadId: string|null}, remote: string, cwd?: string, queue?: typeof runCodexQueue, sleep?: (ms: number) => Promise<void>, log?: (line: string) => void, prepare?: () => Promise<void>, chunkMs?: number}} deps
 * @returns {{stop(): void, done: Promise<void>}}
 */
export function startCodexWake({
  hubRequest,
  state,
  remote,
  cwd = process.cwd(),
  queue = runCodexQueue,
  sleep = defaultSleep,
  log = (line) => process.stderr.write(line),
  prepare = async () => {},
  chunkMs = WAKE_CHUNK_MS,
}) {
  let stopped = false;
  const done = (async () => {
    try {
      await prepare();
    } catch {
      // 직전 채널 복귀 실패: 루프는 그대로 돈다(모델이 join_channel 하면 그 채널을 본다)
    }
    let hubLost = false;
    while (!stopped) {
      let r;
      try {
        r = await hubRequest(
          "agent.wait",
          {
            timeoutMs: chunkMs,
            threadId: state.threadId ?? undefined,
            requireThread: true,
          },
          { timeoutMs: chunkMs + 5000 },
        );
      } catch (err) {
        if (stopped) return;
        // 재접속 중 등으로 계속 실패하는 동안은 한 줄만 남긴다(매 재시도마다 찍으면 로그가 넘친다) —
        // 이 streak 의 첫 실패에만 알린다.
        if (!hubLost) {
          hubLost = true;
          log(`pluriply: auto-wake lost the hub (${err.message}); retrying\n`);
        }
        await sleep(5000); // 허브 재접속 중 등: 쉬었다 다시
        continue;
      }
      if (stopped) return;
      if (hubLost) {
        hubLost = false;
        log("pluriply: auto-wake reconnected\n");
      }
      const fromHub = validThreadId(r?.threadId);
      if (fromHub && !state.threadId) state.threadId = fromHub;
      const found =
        (r?.incoming?.length ?? 0) +
        (r?.results?.length ?? 0) +
        (r?.stalled?.length ?? 0);
      if (found === 0 || !state.threadId) continue;
      const message = formatActivity({ ...r, cwd });
      let lastError = null;
      for (let i = 0; i < 3; i++) {
        try {
          await queue({ remote, threadId: state.threadId, message });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (i < 2) await sleep(2000);
        }
      }
      if (lastError) {
        // 대개 앱 서버가 사라진 세션 종료 중이다 — 이미 가져온 항목은 잃는다(스펙 §11)
        log(
          `pluriply: could not wake this Codex session (${lastError.message}); stopping auto-wake\n`,
        );
        stopped = true;
        return;
      }
    }
  })();
  return {
    stop() {
      stopped = true;
    },
    done,
  };
}
