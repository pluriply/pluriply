import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

/** 패키지 버전 (package.json) */
export const PACKAGE_VERSION = pkg.version;

/**
 * 허브 프로토콜 버전. 허브 연산이 추가·변경될 때 올린다.
 * 1: Plan 1 (암묵). 2: Plan 2a (agent.resume, task.cancel).
 * 3: Plan 2c (worker.status, channel.presence, task.create의 mode/cwd/depth).
 * 4: Plan 2e (agent.hello, 인스턴스 단위 peers, 행위자는 연결에서, dispatch pinned).
 * 5: Plan 3a (task.wait 보류 응답).
 * 6: Plan 3b (task.kind/review, task.complete의 review, task.list의 kind).
 * 7: Plan 4f (연결 토큰 — ping 외 모든 요청은 Authorization: Bearer <token> 연결에서만 처리).
 * 8: Plan 5a (agent.wait 보류 요청, 태스크 dispatch·fallback 기록, 활동 응답의 stalled).
 * 9: Plan 5b (hook.poll의 sessionId로 연결의 threadId 보관, agent.wait의 threadId·requireThread).
 * 10: Plan 6a (agent.hello의 코드 정보·응답의 hub, hub.sessions).
 * 11: Plan 6c (session.report, hello 응답 hub.protocol, hub.sessions의 wakeState·problems, 태스크 events).
 */
export const PROTOCOL_VERSION = 11;
