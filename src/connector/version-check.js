// Plan 6a(스펙 §7): 이 세션(과 허브)이 설치된 것보다 옛 코드로 도는지 도구 응답에서 알린다.
// 디스크는 최대 60초에 한 번 다시 보고, 같은 종류 경고는 5분에 한 번만 붙인다.
import { codeFingerprint } from "../shared/fingerprint.js";

export const CHECK_EVERY_MS = 60_000;
export const REPEAT_EVERY_MS = 5 * 60_000;

/**
 * @param {{
 *   self: {root: string, version: string|null, fingerprint: string|null},
 *   hubInfo: () => ({root?: string|null, fingerprint?: string|null}|null),
 *   fingerprint?: typeof codeFingerprint,
 *   now?: () => number,
 * }} o
 * @returns {() => string[]} 이번 응답에 붙일 경고 줄
 */
export function makeVersionCheck({
  self,
  hubInfo,
  fingerprint = codeFingerprint,
  now = () => performance.now(),
}) {
  let checkedAt = -Infinity;
  /** @type {{connector: string|null, hub: string|null}} */
  let found = { connector: null, hub: null };
  const shownAt = { connector: -Infinity, hub: -Infinity };
  /** 마지막으로 살펴봤을 때의 hubInfo() 지문 — 이게 바뀌면(재접속 hello) 60초를 기다리지 않는다 */
  let lastHubFingerprint;

  function look() {
    const next = { connector: null, hub: null };
    try {
      const disk = self.fingerprint
        ? fingerprint(self.root, "connector")
        : null;
      if (disk && disk.fingerprint !== self.fingerprint) {
        const same = self.version != null && self.version === disk.version;
        const selfText = same
          ? `${self.version} ${self.fingerprint}`
          : (self.version ?? "unknown");
        const diskText = same
          ? `${disk.version} ${disk.fingerprint}`
          : (disk.version ?? "unknown");
        next.connector =
          `pluriply: this session runs older pluriply code (${selfText}) ` +
          `than installed (${diskText}) — restart this tool session to load it.`;
      }
    } catch {
      // 확인 오류는 결과에 영향이 없다
    }
    try {
      const h = hubInfo();
      const disk = h?.root && h.fingerprint ? fingerprint(h.root, "hub") : null;
      if (disk && disk.fingerprint !== h.fingerprint)
        next.hub =
          "pluriply: the hub runs older code than installed — run `pluriply hub restart`.";
    } catch {
      // 위와 같다
    }
    return next;
  }

  return () => {
    const t = now();
    let hubFingerprint = null;
    try {
      hubFingerprint = hubInfo()?.fingerprint ?? null;
    } catch {
      // 위와 같다
    }
    const hubChanged = hubFingerprint !== lastHubFingerprint;
    if (t - checkedAt >= CHECK_EVERY_MS || hubChanged) {
      checkedAt = t;
      lastHubFingerprint = hubFingerprint;
      found = look();
    }
    const out = [];
    for (const k of /** @type {const} */ (["connector", "hub"]))
      if (found[k] && t - shownAt[k] >= REPEAT_EVERY_MS) {
        shownAt[k] = t;
        out.push(found[k]);
      }
    return out;
  };
}
