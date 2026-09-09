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
 */
export const PROTOCOL_VERSION = 6;
