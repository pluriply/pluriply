// 의존성 없는 안전한 마크다운 렌더러. 노드 테스트와 브라우저(/markdown.js)에서 같이 쓴다.
// AI 가 쓴 글은 믿을 수 없으므로 HTML 문자열을 만들지 않는다:
// 글 → 노드 트리(parseMarkdown) → createElement + textContent 로만 DOM(renderMarkdown).

/**
 * @typedef {{type:"text", text:string}
 *   | {type:"strong", children:Inline[]}
 *   | {type:"em", children:Inline[]}
 *   | {type:"code", text:string}
 *   | {type:"link", href:string, children:Inline[]}} Inline
 * @typedef {{type:"heading", level:number, children:Inline[]}
 *   | {type:"paragraph", children:Inline[]}
 *   | {type:"list", ordered:boolean, start?:number, items:Inline[][]}
 *   | {type:"code", text:string}} Block
 */

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^\s*([-*]|\d+\.)\s+(.*)$/;
const FENCE = /^\s*```/;
const SAFE_HREF = /^https?:\/\//i;

/** 인접한 text 노드를 합쳐 넣는다. */
function pushText(out, text) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

/**
 * 인라인 구문을 왼쪽에서 오른쪽으로 훑는다. 닫히지 않은 표시는 글자로 남는다.
 * @param {string} src
 * @returns {Inline[]}
 */
function parseInline(src) {
  /** @type {Inline[]} */
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        out.push({ type: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (ch === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        out.push({
          type: "strong",
          children: parseInline(src.slice(i + 2, end)),
        });
        i = end + 2;
        continue;
      }
      pushText(out, "**");
      i += 2;
      continue;
    } else if (ch === "*" || ch === "_") {
      // 단어 안의 밑줄(snake_case)은 기울임으로 보지 않는다
      const prev = i > 0 ? src[i - 1] : "";
      const intraWord = ch === "_" && /[A-Za-z0-9]/.test(prev);
      const end = intraWord ? -1 : src.indexOf(ch, i + 1);
      if (end > i + 1) {
        out.push({ type: "em", children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    } else if (ch === "[") {
      const mid = src.indexOf("]", i + 1);
      if (mid > 0 && src[mid + 1] === "(") {
        const end = src.indexOf(")", mid + 2);
        if (end > 0) {
          const href = src.slice(mid + 2, end).trim();
          if (SAFE_HREF.test(href)) {
            out.push({
              type: "link",
              href,
              children: parseInline(src.slice(i + 1, mid)),
            });
          } else {
            // 안전하지 않은 주소: 링크 전체를 원문 글자로
            pushText(out, src.slice(i, end + 1));
          }
          i = end + 1;
          continue;
        }
      }
    }
    pushText(out, ch);
    i += 1;
  }
  return out;
}

/**
 * 마크다운 부분집합을 블록 목록으로 파싱한다.
 * @param {string} text
 * @returns {Block[]}
 */
export function parseMarkdown(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  /** @type {Block[]} */
  const blocks = [];
  /** @type {string[]} */
  let para = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({
        type: "paragraph",
        children: parseInline(para.join("\n")),
      });
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flushPara();
      const code = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      blocks.push({
        type: "heading",
        level: h[1].length,
        children: parseInline(h[2]),
      });
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[1]);
      const start = ordered ? parseInt(li[1], 10) : 1;
      const items = [parseInline(li[2])];
      while (i + 1 < lines.length) {
        const next = LIST_ITEM.exec(lines[i + 1]);
        if (!next || /\d/.test(next[1]) !== ordered) break;
        items.push(parseInline(next[2]));
        i++;
      }
      // 번호 목록은 첫 항목의 번호를 남긴다(문단으로 나뉜 "2." 목록이 1 로 보이지 않게)
      if (ordered && start !== 1)
        blocks.push({ type: "list", ordered, start, items });
      else blocks.push({ type: "list", ordered, items });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

/**
 * 인라인 노드를 부모에 붙인다. 글은 항상 텍스트 노드/textContent 로만 들어간다.
 * @param {Inline[]} nodes
 * @param {any} parent
 * @param {Document} doc
 */
function appendInline(nodes, parent, doc) {
  for (const n of nodes) {
    if (n.type === "text") {
      parent.appendChild(doc.createTextNode(n.text));
    } else if (n.type === "code") {
      const el = doc.createElement("code");
      el.textContent = n.text;
      parent.appendChild(el);
    } else {
      const el = doc.createElement(
        n.type === "strong" ? "strong" : n.type === "em" ? "em" : "a",
      );
      if (n.type === "link") {
        el.setAttribute("href", n.href);
        el.setAttribute("rel", "noopener noreferrer");
        el.setAttribute("target", "_blank");
      }
      appendInline(n.children, el, doc);
      parent.appendChild(el);
    }
  }
}

/**
 * 블록 목록을 DOM 조각으로 만든다.
 * @param {Block[]} blocks
 * @param {Document} doc
 * @returns {DocumentFragment}
 */
export function renderMarkdown(blocks, doc) {
  const frag = doc.createDocumentFragment();
  for (const b of blocks) {
    if (b.type === "heading") {
      const el = doc.createElement(`h${b.level}`);
      appendInline(b.children, el, doc);
      frag.appendChild(el);
    } else if (b.type === "paragraph") {
      const el = doc.createElement("p");
      appendInline(b.children, el, doc);
      frag.appendChild(el);
    } else if (b.type === "list") {
      const el = doc.createElement(b.ordered ? "ol" : "ul");
      if (b.ordered && b.start && b.start !== 1)
        el.setAttribute("start", String(b.start));
      for (const item of b.items) {
        const li = doc.createElement("li");
        appendInline(item, li, doc);
        el.appendChild(li);
      }
      frag.appendChild(el);
    } else if (b.type === "code") {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = b.text;
      pre.appendChild(code);
      frag.appendChild(pre);
    }
  }
  return frag;
}
