/**
 * 테스트 뒤처리를 등록의 역순(LIFO)으로 돌린다. node:test 의 t.after 는 등록 순서(FIFO)로 돈다 —
 * 허브를 먼저 등록하고 클라이언트를 나중에 등록하면 허브가 먼저 멈추며 락을 지우고, 재접속하는
 * 클라이언트가 락 없는 임시 홈을 보고 분리된 허브를 새로 띄워 테스트 뒤에 남긴다(Plan 6c 최종 리뷰).
 * 허브를 만든 직후 defer(() => hub.stop()) 로 등록해도 클라이언트를 닫은 뒤에 멈춘다.
 * 하나가 던져도 나머지는 모두 돌고, 첫 오류를 마지막에 던진다.
 * @param {import("node:test").TestContext} t @returns {(fn: () => unknown) => void}
 */
export function teardown(t) {
  const fns = [];
  t.after(async () => {
    const errors = [];
    for (const fn of fns.reverse()) {
      try {
        await fn();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) throw errors[0];
  });
  return (fn) => {
    fns.push(fn);
  };
}
