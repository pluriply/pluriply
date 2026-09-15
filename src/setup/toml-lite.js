/**
 * codex `config.toml` 을 파서 없이 다루는 최소 편집기. 섹션 헤더 줄(`[a.b]`, `[[a]]`)과 그 본문
 * (다음 헤더 전까지) 단위로만 동작한다. 최상위 점 표기(`a.b.key = …`) 와 인라인 테이블은
 * 다루지 않는다(스펙 §11). 줄 끝 주석은 허용한다.
 *
 * 따옴표 헤더(`[projects."/Users/alice/My Project"]`)는 **경계로는** 인식한다. codex 가 바로 그런
 * 헤더를 쓰므로, 못 알아보면 `[mcp_servers.pluriply.*]` 하위 테이블을 지우던 중 그 뒤의 무관한
 * `[projects.…]` 섹션까지 함께 지워진다. 이름 비교는 문자열 그대로 하므로 따옴표 헤더는 그냥
 * "다른 섹션"으로 남는다(따옴표를 풀어 정규화하지는 않는다).
 *
 * 트리플쿼트 문자열(`"""…"""`/`'''…'''`)은 다루지 않는다(스펙 §11). `#` 주석 안에 나온
 * `"""` 한 조각만으로도 진짜 문자열 상태와 무관하게 상태가 뒤집힐 수 있어, 줄 개수만 세는
 * 방식으로는 주석과 문자열을 구분할 수 없다 — 파서 없이 안전하게 가르는 방법이 없으므로,
 * 문서 어디에든 `"""`·`'''` 가 있으면 편집 자체를 거부한다(`hasTripleQuotes`).
 */

/** @param {string} line @returns {string|null} 헤더 줄이면 대괄호 안 이름, 아니면 null */
function headerName(line) {
  // 대괄호 안은 무엇이든(공백·점·슬래시·따옴표) 받는다 — 경계 판정이 목적이다.
  const m = line.match(/^\s*\[\[?\s*(.+?)\s*\]\]?\s*(#.*)?$/);
  return m ? m[1] : null;
}

/**
 * 문서 어디에든(주석·문자열·그 밖 어디든) `"""` 또는 `'''` 가 있는지만 본다. 있으면
 * `insertTomlKey`/`removeTomlSections` 는 편집을 거부한다(스펙 §11 — 트리플쿼트 문자열은
 * 지원 범위 밖).
 * @param {string} text @returns {boolean}
 */
export function hasTripleQuotes(text) {
  return text.includes('"""') || text.includes("'''");
}

/**
 * `[header]` 섹션 본문에 `key = value` 한 줄을 헤더 바로 아래에 넣는다.
 * @param {string} text
 * @param {string} header 대괄호 없는 이름(예: "mcp_servers.pluriply")
 * @param {string} key
 * @param {string} value TOML 리터럴 그대로(예: "600")
 * @returns {{text: string, changed: boolean, reason?: "no-header"|"present"|"unsupported"}}
 */
export function insertTomlKey(text, header, key, value) {
  if (hasTripleQuotes(text))
    return { text, changed: false, reason: "unsupported" };
  const lines = text.split("\n");
  const start = lines.findIndex((l) => headerName(l) === header);
  if (start === -1) return { text, changed: false, reason: "no-header" };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (headerName(lines[i]) !== null) {
      end = i;
      break;
    }
  }
  const keyRe = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`,
  );
  const hasKey = lines.slice(start + 1, end).some((l) => keyRe.test(l));
  if (hasKey) return { text, changed: false, reason: "present" };
  lines.splice(start + 1, 0, `${key} = ${value}`);
  return { text: lines.join("\n"), changed: true };
}

/**
 * 이름이 `prefix` 이거나 `prefix.` 로 시작하는 모든 섹션(헤더 + 본문)을 지운다.
 * @param {string} text @param {string} prefix 예: "mcp_servers.pluriply"
 * @returns {{text: string, removed: number, reason?: "unsupported"}}
 */
export function removeTomlSections(text, prefix) {
  if (hasTripleQuotes(text)) return { text, removed: 0, reason: "unsupported" };
  const lines = text.split("\n");
  const out = [];
  let removed = 0;
  let skipping = false;
  lines.forEach((line) => {
    const name = headerName(line);
    if (name !== null) {
      skipping = name === prefix || name.startsWith(`${prefix}.`);
      if (skipping) {
        removed++;
        return;
      }
    }
    if (!skipping) out.push(line);
  });
  return { text: out.join("\n"), removed };
}
