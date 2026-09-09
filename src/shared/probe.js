import WebSocket from "ws";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * 포트의 허브에 ping을 보내 응답 payload를 돌려준다.
 * 연결 실패, 오류 응답, 시간 초과는 모두 null.
 * @param {number} port @param {number} [timeoutMs]
 * @returns {Promise<object|null>}
 */
export function pingHub(port, timeoutMs = 1000) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return Promise.resolve(null);
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    ws.on("open", () =>
      ws.send(JSON.stringify({ id: "probe", type: "ping", payload: {} })),
    );
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id === "probe") done(msg.ok ? msg.payload : null);
      } catch {
        done(null);
      }
    });
    ws.on("error", () => done(null));
    ws.on("close", () => done(null));
  });
}

/** @param {number} pid @returns {boolean} 프로세스가 존재하는지 (권한 없음도 존재로 본다) */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** @param {string} home @returns {string} home 절대경로의 sha256 앞 12자 */
export function homeId(home) {
  return createHash("sha256").update(resolve(home)).digest("hex").slice(0, 12);
}
