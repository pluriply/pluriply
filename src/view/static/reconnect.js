// 다시 잇기 실패 세기(화면 app.js 가 쓴다). 브라우저·노드 공용 순수 모듈이라 테스트가 직접 가져온다.

/** 연속 실패가 이만큼이면 "연결이 끊겼습니다" 띠를 보인다(재시도 간격 2초 → 약 6초). */
export const DOWN_AFTER = 3;

/**
 * @param {number} [limit]
 * @returns {{fail(): boolean, ok(): void, readonly fails: number, readonly down: boolean}}
 */
export function makeReconnect(limit = DOWN_AFTER) {
  let fails = 0;
  return {
    /** 실패 한 번. 끊김 표시를 할 때면 참. */
    fail() {
      fails += 1;
      return fails >= limit;
    },
    /** 다시 이어졌다 — 세기를 처음부터. */
    ok() {
      fails = 0;
    },
    get fails() {
      return fails;
    },
    get down() {
      return fails >= limit;
    },
  };
}
