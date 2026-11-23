import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMarkdown,
  renderMarkdown,
} from "../../src/view/static/markdown.js";

const t = (text) => ({ type: "text", text });

test("markdown parses the supported subset", () => {
  const src =
    "# T\n\npara **b** *i* `c` [x](https://a.b)\n\n- one\n- two\n\n```js\nlet a = 1;\n```";
  assert.deepEqual(parseMarkdown(src), [
    { type: "heading", level: 1, children: [t("T")] },
    {
      type: "paragraph",
      children: [
        t("para "),
        { type: "strong", children: [t("b")] },
        t(" "),
        { type: "em", children: [t("i")] },
        t(" "),
        { type: "code", text: "c" },
        t(" "),
        { type: "link", href: "https://a.b", children: [t("x")] },
      ],
    },
    { type: "list", ordered: false, items: [[t("one")], [t("two")]] },
    { type: "code", text: "let a = 1;" },
  ]);
});

test("markdown never yields html or unsafe links", () => {
  const src =
    "<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](data:text/html,1)";
  const types = new Set();
  let joined = "";
  const walk = (n) => {
    types.add(n.type);
    if (n.type === "text") joined += n.text;
    for (const c of n.children ?? []) walk(c);
  };
  for (const b of parseMarkdown(src)) walk(b);
  assert.deepEqual([...types].sort(), ["paragraph", "text"]);
  assert.equal(joined, src);
});

test("markdown keeps unclosed markers as text", () => {
  assert.deepEqual(parseMarkdown("**open"), [
    { type: "paragraph", children: [t("**open")] },
  ]);
});

test("renderMarkdown builds nodes with textContent only", () => {
  const tags = [];
  const texts = [];
  const mk = (tag) => {
    const el = {
      tag,
      children: [],
      attrs: {},
      appendChild(c) {
        el.children.push(c);
        return c;
      },
      setAttribute(k, v) {
        el.attrs[k] = v;
      },
      set textContent(v) {
        texts.push(v);
      },
      set innerHTML(_v) {
        throw new Error("innerHTML is forbidden");
      },
    };
    tags.push(tag);
    return el;
  };
  const doc = {
    createElement: mk,
    createDocumentFragment: () => mk("#fragment"),
    createTextNode: (s) => {
      texts.push(s);
      return { text: s };
    },
  };
  assert.doesNotThrow(() => renderMarkdown(parseMarkdown("**<b>x</b>**"), doc));
  assert.ok(tags.includes("strong"));
  assert.ok(texts.includes("<b>x</b>"));
  assert.ok(!tags.includes("b"));
});

test("ordered list keeps its first number", () => {
  assert.deepEqual(parseMarkdown("2. a\n3. b"), [
    { type: "list", ordered: true, start: 2, items: [[t("a")], [t("b")]] },
  ]);
  const blocks = parseMarkdown("1. a\n\ntext\n\n2. b");
  assert.equal(blocks[2].start, 2);
  assert.equal(parseMarkdown("1. a")[0].start, undefined);
  const attrs = [];
  const mk = (tag) => ({
    appendChild: (c) => c,
    setAttribute: (k, v) => attrs.push([tag, k, v]),
    set textContent(_v) {},
  });
  renderMarkdown(parseMarkdown("2. a"), {
    createElement: mk,
    createDocumentFragment: () => mk("#f"),
    createTextNode: () => ({}),
  });
  assert.deepEqual(attrs, [["ol", "start", "2"]]);
});
