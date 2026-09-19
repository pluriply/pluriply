import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { pluriplyHome } from "../shared/paths.js";
import { liveHub, spawnHub } from "../hub/index.js";
import { PROTOCOL_VERSION } from "../shared/version.js";
import { readLock } from "../shared/lock.js";

const RECONNECT_TOTAL_MS = 60_000;
const RECONNECT_MAX_DELAY_MS = 5_000;
/**
 * 연결이 "자리 잡았다"고 보는 최소 유지 시간(Plan 4g). 이보다 짧게 살고 끊긴 연결은
 * 실패한 시도로 세어, 다음 재접속이 대기·총 제한을 처음부터 다시 세지 않게 한다
 * (2026-09-17 사고: 접속 즉시 끊김이 반복되자 대기도 포기도 없이 초당 수백 회 돌았다).
 */
const STABLE_MS = 5_000;
/**
 * request()가 this.reconnecting을 기다리는 상한. BARRIER_TIMEOUT_MS(재접속 후
 * "reconnected" 리스너를 기다리는 상한)보다 넉넉히 커야 한다 — this.reconnecting은
 * 그 리스너뿐 아니라 허브 재스폰 전체(ensureHub → 없으면 spawnHub, 대기가 최대
 * 20초다)까지 포함하므로, 이 값이 짧으면 재접속(허브 재스폰 포함)이 아직
 * 끝나지 않았는데 request()가 먼저 포기하고 readyState===OPEN만 보고 재join이
 * 안 끝난 소켓으로 그대로 전송해버릴 수 있다.
 * 이 값이 덮는 것은 재접속 "한 회차"다(#reconnect 루프 전체가 아니다): liveHub의 ping
 * 1s + spawnHub 20s(Plan 4g에서 5s→20s; 루프가 기한을 liveHub 뒤에 확인해 최대 1s 더
 * 넘길 수 있다) + tryConnect 3s + BARRIER_TIMEOUT_MS 5s ≈ 30s. 여기에 여유를 두어 35s로
 * 한다. this.reconnecting은 #reconnect 루프 전체(최대 reconnectTotalMs=60s, 즉시
 * 재시도가 붙으면 그 이상)에 걸쳐 있어 어떤 상수도 그 전체를 덮지 못한다 — 루프가 더
 * 길어지면 request()는 기존의 "hub connection closed" 거절로 물러난다. spawnHub의
 * 대기가 다시 바뀌면 이 값도 함께 옮겨야 한다. raceSleep이 경합이 끝나는 즉시 타이머를
 * 걷으므로 값을 키워도 프로세스 종료가 늦어지지 않는다.
 * 사슬 TAKEOVER_GRACE_MS < SPAWN_WAIT_MS < REQUEST_WAIT_MS 는 test/hub/timing.test.js 가 고정한다.
 */
export const REQUEST_WAIT_MS = 35_000;
/**
 * 재접속 성공 뒤 "reconnected" 리스너(예: 채널 재join)를 기다리는 최대 시간.
 * 리스너가 절대 끝나지 않아도(응답 없는 hub.request 등) 이 시간이 지나면
 * 재접속 루프가 포기하고 넘어가, this.reconnecting이 영원히 non-null로
 * 남아 이후의 모든 끊김을 무시하는 사태를 막는다.
 */
const BARRIER_TIMEOUT_MS = 5_000;

/**
 * 재접속 후 한 번만 재시도해도 안전한, 읽기 전용(부수효과 없는) 허브 연산.
 * `task.create`/`channel.create`/`channel.join`/`task.cancel`/`task.claim`/`task.complete`/
 * `context.add` 등은 여기 넣지 않는다: 허브 상태는 `<home>/channels/*.json`에 영속화되므로,
 * 요청이 실제로는 허브에 도달해 처리된 뒤 응답만 유실된 경우 재전송이 같은 연산을
 * 한 번 더(예: 태스크 중복 생성, 워커 중복 스폰) 실행할 수 있다.
 */
const RETRYABLE = new Set([
  "ping",
  "task.get",
  "task.wait",
  "task.list",
  "channel.peers",
  "channel.presence",
  "worker.status",
  "context.list",
]);

// `p` 와 ms 타이머의 경합. 경합이 끝나면 타이머를 걷는다 — 진 타이머가 남으면 상대가 먼저
// 이겨도 N초 동안 이벤트 루프가 열려 있어 프로세스(테스트 파일 포함) 종료가 그만큼 늦어진다.
// unref 가 아니라 clear 인 이유: 경합이 진행 중일 때는 타이머가 루프를 붙잡고 있어야
// (예: 끝나지 않는 리스너를 배리어가 끊는 경우) 대기가 조용히 잘리지 않는다.
const raceSleep = (p, ms) => {
  let t;
  const timer = new Promise((r) => {
    t = setTimeout(r, ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
};

/**
 * @param {number} port @param {number} [timeoutMs] @param {string} [token] 허브 락의 연결 토큰(Plan 4f).
 *   있으면 업그레이드 헤더 `Authorization: Bearer <token>` 으로 보낸다. 없으면(구버전 허브) 헤더 없이 붙는다.
 * @returns {Promise<WebSocket|null>} 연결 실패 시 null
 */
function tryConnect(port, timeoutMs = 1000, token) {
  return new Promise((resolve) => {
    const ws = token
      ? new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      : new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(null);
    }, timeoutMs);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** ping 정보로 구형 허브 여부 판정 */
function staleFrom(info, port) {
  if (info.protocol && info.protocol >= PROTOCOL_VERSION) return null;
  return {
    version: info.version ?? "unknown",
    protocol: info.protocol ?? 1,
    pid: info.pid ?? info.lockPid,
    port,
  };
}

/**
 * 허브가 없으면 detached로 기동한다.
 * @returns {Promise<{port: number, info: object}>} info는 ping 응답(+port, lockPid)
 */
export async function ensureHub({ home = pluriplyHome() } = {}) {
  const live = (await liveHub(home)) ?? (await spawnHub({ home }));
  return { port: live.port, info: live };
}

/**
 * 허브와의 요청/응답 클라이언트. id 상관관계로 동시 요청을 지원하고,
 * 연결이 끊기면 백오프로 재접속한다. 이벤트: reconnected({port}), dead.
 */
export class HubClient extends EventEmitter {
  /** @type {() => void} close()가 호출되면 풀린다; #reconnect의 대기를 즉시 깨운다 */
  #resolveClosed;
  /** @type {Promise<void>} */
  #closedSignal;

  /**
   * @param {WebSocket} ws
   * @param {{home?: string, reconnectTotalMs?: number, stableMs?: number, token?: string}} [opts]
   *   home이 없으면 재접속하지 않는다. reconnectTotalMs는 재접속을 포기하기까지의 총 시간
   *   (기본 RECONNECT_TOTAL_MS), stableMs는 연결이 자리 잡았다고 보는 최소 유지 시간
   *   (기본 STABLE_MS) — 둘 다 테스트에서 짧게 만드는 데 쓴다. token은 이 소켓이 업그레이드
   *   헤더로 보낸 허브 연결 토큰(Plan 4f)이다.
   */
  constructor(
    ws,
    {
      home,
      reconnectTotalMs = RECONNECT_TOTAL_MS,
      stableMs = STABLE_MS,
      token,
    } = {},
  ) {
    super();
    this.home = home;
    this.reconnectTotalMs = reconnectTotalMs;
    this.stableMs = stableMs;
    this.pending = new Map();
    this.seq = 0;
    this.stale = null;
    this.closed = false;
    this.dead = false;
    /**
     * Plan 4g: dead 가 허브의 unauthorized 응답 때문이면 그 문구. request() 오류에 붙여
     * 사용자가 "도구를 다시 시작하라"는 안내를 그대로 보게 한다.
     * @type {string|null}
     */
    this.deadReason = null;
    /**
     * 이 연결에서 받은 unauthorized 응답(문구 + 그 연결에 쓴 토큰). #reconnect 가
     * 배리어 뒤에 보고 판단한다.
     * @type {{message: string, token: string|undefined}|null}
     */
    this.lastUnauthorized = null;
    /**
     * Plan 4g: "토큰이 바뀌었으니 대기 없이 한 번 더"를 한 번만 허용한다. 허브가 계속
     * 락을 새 토큰으로 갈아치우면 매 회차가 retry 가 되어 사다리가 서지 않기 때문이다.
     * 정상 연결(ok)을 확인하면 다시 false 로 돌려 한 번의 기회를 되찾는다.
     */
    this.retriedOnce = false;
    /** @type {Promise<void>|null} 재접속 진행 중이면 그 프라미스 */
    this.reconnecting = null;
    /**
     * Plan 4g: 재접속 백오프를 인스턴스에 남긴다. #reconnect 호출마다 새로 세면
     * "접속 성공 → 곧바로 끊김"이 반복될 때 대기도 포기도 없이 돌게 된다.
     * null이면 다음 #reconnect가 각각 250ms·now + reconnectTotalMs로 새로 잡는다.
     * @type {number|null}
     */
    this.backoffDelay = null;
    /** @type {number|null} */
    this.backoffDeadline = null;
    this.#closedSignal = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    this.#attach(ws, token);
  }

  #attach(ws, token) {
    // 이전 소켓의 리스너를 떼어낸다: 늦게 도착하는 error/close가 새 연결의
    // pending 요청을 잘못 실패시키는 것을 막는다 (기존 소켓이 없으면 no-op).
    this.ws?.removeAllListeners();
    // 허브는 인증 못 한 연결도 열어 둔다(Plan 4f) — 재시도로 갈아탈 때 옛 소켓이 새지 않게 닫는다
    this.ws?.terminate();
    this.ws = ws;
    /** Plan 4g: 이 연결이 붙은 시각 — stableMs 안에 끊기면 실패한 시도로 센다 */
    this.attachedAt = Date.now();
    /** @type {string|undefined} 이 연결이 업그레이드 헤더로 보낸 토큰 */
    this.attachedToken = token;
    // 표시는 연결 단위 — 옛 연결의 거절이 새 연결을 dead 로 만들지 않게
    this.lastUnauthorized = null;
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // 허브가 보낸 비 JSON 프레임은 무시
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.payload);
        return;
      }
      const message = msg.error?.message ?? "hub error";
      // Plan 4g: 토큰이 틀렸다는 응답은 같은 토큰으로 재시도해도 결과가 같다.
      // 어느 연결에서 받았는지(토큰)까지 남겨 #reconnect 가 판단한다.
      if (message.startsWith("unauthorized:"))
        this.lastUnauthorized = { message, token: this.attachedToken };
      entry.reject(new Error(message));
    });
    ws.on("close", () => this.#onLost(new Error("hub connection closed")));
    ws.on("error", (err) =>
      this.#onLost(new Error(`hub connection error: ${err.message}`)),
    );
  }

  #failAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  #onLost(err) {
    this.#failAll(err);
    if (this.closed || this.dead || this.reconnecting || !this.home) return;
    // Plan 4g: stableMs 이상 유지된 연결이 끊긴 것이면 정상적인 한 번의 끊김으로 보고
    // 사다리를 초기화한다(허브 재시작 같은 흔한 경우는 지금처럼 곧바로 재접속한다).
    // 그보다 짧게 살고 끊겼으면 실패한 시도로 보고 대기·총 제한을 이어서 쓴다.
    if (Date.now() - this.attachedAt >= this.stableMs) {
      this.backoffDelay = null;
      this.backoffDeadline = null;
    }
    this.reconnecting = this.#reconnect().finally(() => {
      this.reconnecting = null;
    });
    // close()가 이 재접속 도중에 호출되고 그 순간 아무도 request()에서
    // this.reconnecting을 기다리고 있지 않으면, #reconnect가 정상 반환하므로
    // 이 프라미스는 사실 거부되지 않는다. 그래도 향후 리스너(예: "reconnected"
    // 구독자)가 동기적으로 던지는 경우까지 대비해 처리기를 미리 붙여 둔다.
    this.reconnecting.catch(() => {});
  }

  async #reconnect() {
    // Plan 4g: 대기와 총 제한은 인스턴스에 남는다. 직전 시도가 실패했다면
    // (접속 실패든, stableMs 전에 끊긴 연결이든) 다음 시도 전에 그 대기를 먼저
    // 치른다 — 접속이 성공하면 루프가 곧바로 반환하므로, 대기를 루프 끝에만
    // 두면 사다리가 전혀 올라가지 않는다(2026-09-17 폭주의 핵심).
    this.backoffDeadline ??= Date.now() + this.reconnectTotalMs;
    let retryNow = false;
    while (Date.now() < this.backoffDeadline && !this.closed) {
      if (retryNow) {
        retryNow = false; // 직전 회차가 "허브 교체" 판정: 대기 없이 곧장 다시 시도한다
      } else if (this.backoffDelay === null) {
        this.backoffDelay = 250; // 첫 시도는 대기 없이
      } else {
        // 대기는 close()가 즉시 깨울 수 있어야 한다
        await raceSleep(this.#closedSignal, this.backoffDelay);
        if (this.closed) return;
        // 대기 도중 총 제한이 지났으면 한 번 더 시도하지 않고 포기 경로로 간다
        if (Date.now() >= this.backoffDeadline) break;
        this.backoffDelay = Math.min(
          this.backoffDelay * 2,
          RECONNECT_MAX_DELAY_MS,
        );
      }
      try {
        const { port, info } = await ensureHub({ home: this.home });
        if (this.closed) return; // close()가 ensureHub 대기 중에 호출됨
        const ws = await tryConnect(port, 3000, info.token);
        if (this.closed) {
          ws?.terminate(); // close()가 tryConnect 대기 중에 호출됨: 새 소켓을 붙이지 않는다
          return;
        }
        if (ws) {
          this.#attach(ws, info.token);
          this.stale = staleFrom(info, port);
          // emit 대신 리스너를 직접 호출해 반환 프라미스를 기다린다: 이렇게 하면
          // this.reconnecting은 리스너(도구 계층의 채널 재join)가 끝난 뒤에야
          // 해소되고, request()가 reconnecting을 기다리는 로직(readyState와
          // 무관하게 reconnecting이 있으면 기다린다) 덕분에 재접속 후 첫 요청은
          // 재join 뒤에 나간다. 리스너 예외는 삼킨다(allSettled).
          // rawListeners를 쓴다: listeners()는 .once() 래퍼를 풀어 원본 콜백을
          // 돌려주므로 여기서 직접 호출하면 emit()과 달리 "한 번 호출 후 자동
          // 해제"가 발동하지 않아 같은 .once 리스너가 재접속마다 다시 불린다.
          // rawListeners가 돌려주는 래퍼를 그대로 호출해야 emit()과 동일하게
          // once가 정확히 한 번만 불린다.
          // 리스너가 응답 없이 멈춰도 이 대기가 영원히 끝나지 않으면 this.reconnecting이
          // 계속 non-null로 남아 #onLost가 이후의 모든 끊김을 무시하게 된다 —
          // BARRIER_TIMEOUT_MS로 상한을 둬서 그 사태를 막는다(리스너 자체는
          // 백그라운드에서 계속 돌아가지만 결과는 기다리지 않는다).
          await raceSleep(
            Promise.allSettled(
              this.rawListeners("reconnected").map((fn) =>
                Promise.resolve().then(() => fn({ port })),
              ),
            ),
            BARRIER_TIMEOUT_MS,
          );
          const verdict = this.#afterBarrier();
          if (verdict === "ok") {
            // Plan 4g: 배리어 도중 새 소켓이 닫히면 #onLost 는 this.reconnecting 때문에 그냥
            // 돌아간다. 여기서 "ok" 로 끝내면 CLOSED 소켓만 남아 dead 도 재접속도 아닌 채
            // 모든 요청이 실패한다 — 실패한 시도로 보고 루프를 잇는다(다음 회차가 백오프 대기).
            if (this.ws.readyState === WebSocket.OPEN) return;
            continue;
          }
          if (verdict === "dead") {
            if (!this.closed) {
              this.dead = true;
              this.emit("dead");
            }
            // 허브는 인증 못 한 연결을 열어 둔다(Plan 4f) — 도구 재시작까지 소켓이 남지 않게 닫는다.
            // dead 를 먼저 세웠으므로 이 끊김의 #onLost 는 재접속하지 않는다.
            this.ws.terminate();
            return;
          }
          retryNow = true; // "retry": 허브가 막 교체됐다 — 대기 없이 한 번 더
          continue;
        }
      } catch {
        // 허브가 아직 없음: 재시도
      }
    }
    if (!this.closed) {
      this.dead = true;
      this.emit("dead");
    }
  }

  /**
   * 재접속 직후(배리어 뒤) 이 연결을 쓸 수 있는지 판정한다. Plan 4g.
   * @returns {"ok"|"retry"|"dead"} retry: 락의 토큰이 이미 바뀌었다(허브가 막 교체됨) —
   *   대기 없이 한 번 더 돈다. dead: 같은 토큰이 그대로 거절됐다 — 기다려도 같다.
   */
  #afterBarrier() {
    const unauth = this.lastUnauthorized;
    if (!unauth || unauth.token !== this.attachedToken) {
      this.retriedOnce = false; // 정상 연결: 재시도 기회를 되찾는다
      return "ok";
    }
    this.lastUnauthorized = null;
    const lockToken = readLock(this.home)?.token;
    // 허브 교체로 보이는 첫 거절만 재시도한다 — 토큰이 또 바뀌어도 두 번째부터는 포기
    if (lockToken && lockToken !== unauth.token && !this.retriedOnce) {
      this.retriedOnce = true;
      return "retry";
    }
    this.deadReason = unauth.message;
    return "dead";
  }

  /**
   * 허브에 접속한다. 허브 프로토콜이 커넥터보다 낮으면 `stale`에 기록하되 접속은 유지한다.
   * @param {{home?: string, reconnectTotalMs?: number, stableMs?: number}} [opts] @returns {Promise<HubClient>}
   */
  static async connect({
    home = pluriplyHome(),
    reconnectTotalMs,
    stableMs,
  } = {}) {
    const { port, info } = await ensureHub({ home });
    const ws = await tryConnect(port, 3000, info.token);
    if (!ws) throw new Error("could not connect to pluriply hub");
    const client = new HubClient(ws, {
      home,
      reconnectTotalMs,
      stableMs,
      token: info.token,
    });
    client.stale = staleFrom(info, port);
    return client;
  }

  /**
   * @param {string} type @param {object} [payload]
   * @param {{duringReconnect?: boolean, timeoutMs?: number}} [opts] duringReconnect: true면 this.reconnecting을
   *   기다리지 않고 곧장 보낸다. #reconnect가 소켓을 붙인(#attach) 직후 "reconnected"
   *   리스너를 호출해 그 반환 프라미스를 기다리는 동안에는, readyState가 이미 OPEN이라도
   *   this.reconnecting은 아직 non-null이다 — 이 옵션 없이 그 리스너 자신이 request()를
   *   부르면(예: tools.js의 채널 재join) this.reconnecting을 기다리다 자기 자신을
   *   기다리는 교착 상태에 빠지므로, 리스너 안에서 나가는 요청에는 반드시 넘겨야 한다.
   *   timeoutMs: 있으면 그 시간 안에 응답이 없을 때 "hub request timed out: <type>"으로
   *   거부하고 pending 항목을 지운다(허브가 소켓은 받아들이되 응답을 안 보내는 경우 대비 —
   *   예: worker list가 죽은 허브를 붙잡고 무한정 기다리는 사고를 막는다).
   * @returns {Promise<object>}
   */
  async request(
    type,
    payload = {},
    { duringReconnect = false, timeoutMs } = {},
  ) {
    if (this.dead)
      throw new Error(
        this.deadReason
          ? `hub unreachable; restart the tool (${this.deadReason})`
          : "hub unreachable; restart the tool",
      );
    // readyState만으로는 부족하다: #reconnect가 #attach로 소켓을 OPEN 상태로
    // 바꾼 뒤에도 "reconnected" 리스너(채널 재join)가 끝날 때까지 this.reconnecting은
    // non-null로 남아있다. 그 틈에 나간 request()가 재join보다 먼저 허브에 도착하는
    // 것을 막으려면 readyState와 무관하게 reconnecting이 있으면 기다려야 한다.
    if (this.reconnecting && !duringReconnect) {
      await raceSleep(this.reconnecting, REQUEST_WAIT_MS);
    }
    if (this.ws.readyState !== WebSocket.OPEN)
      throw new Error("hub connection closed");
    try {
      return await this.#send(type, payload, timeoutMs);
    } catch (err) {
      // readyState가 아직 OPEN으로 보이는 순간 보냈는데 그 직후 끊긴 경우:
      // 재접속이 이미 시작됐다면 그걸 기다렸다가 한 번만 더 시도한다.
      // 주의: 허브 상태는 인메모리가 아니라 `<home>/channels/*.json`에 영속화된다
      // (store.js) — 재시작한 허브도 같은 파일을 그대로 읽는다. 즉 첫 전송이
      // 실제로 허브에 도달해 처리된 뒤 응답만 유실됐다면, 재전송은 같은 연산을
      // 두 번째로 실행한다(예: task.create가 태스크를 두 개 만들고 워커도
      // 두 번 뜬다). 그래서 재시도는 부수효과가 없는 읽기 전용 연산으로만
      // 한정한다 — RETRYABLE에 없는 타입은 원래 에러로 즉시 거부한다.
      if (
        RETRYABLE.has(type) &&
        err.message === "hub connection closed" &&
        this.reconnecting &&
        !duringReconnect
      ) {
        await raceSleep(this.reconnecting, REQUEST_WAIT_MS);
        if (this.ws.readyState === WebSocket.OPEN)
          return this.#send(type, payload, timeoutMs);
      }
      throw err;
    }
  }

  /**
   * @param {string} type @param {object} payload @param {number} [timeoutMs]
   * @returns {Promise<object>}
   */
  #send(type, payload, timeoutMs) {
    const id = `req_${++this.seq}`;
    return new Promise((resolve, reject) => {
      let timer;
      // resolve/reject 어느 쪽이 먼저 오든(정상 응답 vs 타임아웃) 남은 타이머를 지우고
      // pending에서 항목을 지운다 — 메시지 핸들러의 delete와 겹쳐도 Map.delete는 멱등이다.
      const settle = (fn) => (arg) => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        fn(arg);
      };
      const entry = { resolve: settle(resolve), reject: settle(reject) };
      this.pending.set(id, entry);
      if (timeoutMs) {
        timer = setTimeout(
          () => entry.reject(new Error(`hub request timed out: ${type}`)),
          timeoutMs,
        );
        timer.unref?.(); // 이 타이머만으로 프로세스가 살아있지 않게 한다(CLI 종료용)
      }
      this.ws.send(JSON.stringify({ id, type, payload }));
    });
  }

  close() {
    this.closed = true;
    this.#resolveClosed();
    this.ws.close();
  }
}

/**
 * 이미 떠 있는 허브에만 접속한다. 없으면 스폰하지 않고 null을 반환한다.
 * home을 넘기지 않은 HubClient를 돌려주므로 끊겨도 재접속하지 않는다.
 * @param {{home?: string}} [opts] @returns {Promise<HubClient|null>}
 */
export async function connectIfLive({ home = pluriplyHome() } = {}) {
  const live = await liveHub(home);
  if (!live) return null;
  const ws = await tryConnect(live.port, 3000, live.token);
  if (!ws) return null;
  const client = new HubClient(ws, { token: live.token });
  client.stale = staleFrom(live, live.port);
  return client;
}
