import { test } from "node:test";
import assert from "node:assert/strict";
import {
  insertTomlKey,
  removeTomlSections,
  hasTripleQuotes,
} from "../../src/setup/toml-lite.js";

const SAMPLE = [
  'model = "gpt"',
  "",
  "[mcp_servers.pluriply]",
  'command = "node"',
  'args = ["/p/bin.js", "connector"]',
  "",
  "[mcp_servers.pluriply.tools.join_channel]",
  'approval_mode = "approve"',
  "",
  "[mcp_servers.other]",
  'command = "x"',
  "",
  "[tui]",
  "nux = 1",
].join("\n");

test("insertTomlKey adds the key right under the header and leaves other sections alone", () => {
  const r = insertTomlKey(
    SAMPLE,
    "mcp_servers.pluriply",
    "tool_timeout_sec",
    "600",
  );
  assert.equal(r.changed, true);
  const lines = r.text.split("\n");
  assert.equal(lines[2], "[mcp_servers.pluriply]");
  assert.equal(lines[3], "tool_timeout_sec = 600");
  assert.equal(lines[4], 'command = "node"');
  assert.ok(r.text.includes('[mcp_servers.other]\ncommand = "x"'));
});

test("insertTomlKey keeps an existing key in the same section and ignores the key in other sections", () => {
  const withKey = SAMPLE.replace(
    'command = "node"',
    'tool_timeout_sec = 45\ncommand = "node"',
  );
  assert.deepEqual(
    insertTomlKey(withKey, "mcp_servers.pluriply", "tool_timeout_sec", "600"),
    {
      text: withKey,
      changed: false,
      reason: "present",
    },
  );
  const other = SAMPLE.replace('command = "x"', "tool_timeout_sec = 45");
  assert.equal(
    insertTomlKey(other, "mcp_servers.pluriply", "tool_timeout_sec", "600")
      .changed,
    true,
  );
});

test("insertTomlKey reports a missing header without touching the text", () => {
  assert.deepEqual(
    insertTomlKey('model = "gpt"\n', "mcp_servers.pluriply", "k", "1"),
    {
      text: 'model = "gpt"\n',
      changed: false,
      reason: "no-header",
    },
  );
});

test("removeTomlSections drops the section and its sub-tables but not similarly named neighbours", () => {
  const r = removeTomlSections(
    SAMPLE + '\n[mcp_servers.pluriply2]\ncommand = "y"\n',
    "mcp_servers.pluriply",
  );
  assert.equal(r.removed, 2);
  assert.doesNotMatch(
    r.text,
    /pluriply\]|pluriply\.tools|approval_mode|"node"/,
  );
  assert.match(r.text, /\[mcp_servers\.other\]\ncommand = "x"/);
  assert.match(r.text, /\[mcp_servers\.pluriply2\]\ncommand = "y"/);
  assert.match(r.text, /^model = "gpt"/);
  assert.match(r.text, /\[tui\]\nnux = 1/);
  assert.equal(removeTomlSections("a = 1\n[b]\nc = 2\n", "zzz").removed, 0);
});

test("array-table headers end a section too", () => {
  const text =
    '[mcp_servers.pluriply]\ncommand = "n"\n[[profiles]]\nname = "p"\n';
  const r = removeTomlSections(text, "mcp_servers.pluriply");
  assert.equal(r.removed, 1);
  assert.equal(r.text, '[[profiles]]\nname = "p"\n');
});

test('quoted headers with spaces are section boundaries: an unrelated [projects."…"] survives the pluriply sweep', () => {
  // codex 가 실제로 쓰는 모양 — 경로가 헤더 안에 따옴표로 들어가고 공백·점·슬래시를 담는다.
  const text = [
    "[mcp_servers.pluriply]",
    'command = "node"',
    "",
    "[mcp_servers.pluriply.tools.x]",
    'approval_mode = "approve"',
    "",
    '[projects."/a b/c"]',
    'trust_level = "trusted"',
    "",
    "[tui]",
    "nux = 1",
  ].join("\n");
  const r = removeTomlSections(text, "mcp_servers.pluriply");
  assert.equal(r.removed, 2);
  assert.doesNotMatch(r.text, /pluriply|approval_mode/);
  assert.match(r.text, /\[projects\."\/a b\/c"\]\ntrust_level = "trusted"/);
  assert.match(r.text, /\[tui\]\nnux = 1/);
});

/**
 * 트리플쿼트 문자열 값 안에 우연히 `[mcp_servers.pluriply]` 모양의 줄이 들어 있고, 그 뒤에
 * 진짜 섹션도 따로 있는 문서. `"""`/`'''` 가 어디에 있든 편집기는 문서 전체를 손대지 않는다
 * (문자열/주석 상태를 파서 없이 안전하게 가를 방법이 없다는 게 컨트롤러 판정 — 스펙 §11).
 * @param {string} quote `"""` 또는 `'''`
 */
function docWithMultilineString(quote) {
  return [
    `developer_instructions = ${quote}`,
    "[mcp_servers.pluriply]",
    "fake",
    quote,
    'approval_policy = "never"',
    "",
    "[mcp_servers.pluriply]",
    'command = "node"',
    "",
    "[tui]",
    "nux = 1",
  ].join("\n");
}

for (const quote of ['"""', "'''"]) {
  test(`insertTomlKey refuses a document containing a ${quote} triple-quoted string anywhere`, () => {
    const text = docWithMultilineString(quote);
    assert.deepEqual(
      insertTomlKey(text, "mcp_servers.pluriply", "tool_timeout_sec", "600"),
      { text, changed: false, reason: "unsupported" },
    );
  });

  test(`removeTomlSections refuses a document containing a ${quote} triple-quoted string anywhere`, () => {
    const text = docWithMultilineString(quote);
    assert.deepEqual(removeTomlSections(text, "mcp_servers.pluriply"), {
      text,
      removed: 0,
      reason: "unsupported",
    });
  });
}

test('insertTomlKey and removeTomlSections refuse a document with """ only inside a # comment', () => {
  const text = [
    '# note: """ not a real string',
    "[mcp_servers.pluriply]",
    'command = "node"',
    "",
    "[tui]",
    "nux = 1",
  ].join("\n");
  assert.deepEqual(
    insertTomlKey(text, "mcp_servers.pluriply", "tool_timeout_sec", "600"),
    { text, changed: false, reason: "unsupported" },
  );
  assert.deepEqual(removeTomlSections(text, "mcp_servers.pluriply"), {
    text,
    removed: 0,
    reason: "unsupported",
  });
});

test("hasTripleQuotes detects \"\"\" and ''' anywhere and only them", () => {
  assert.equal(hasTripleQuotes('a = """x"""'), true);
  assert.equal(hasTripleQuotes("a = '''x'''"), true);
  assert.equal(hasTripleQuotes('# """ in a comment'), true);
  assert.equal(hasTripleQuotes('model = "gpt"\n[a]\nb = "c"\n'), false);
  assert.equal(hasTripleQuotes(""), false);
});

test("insertTomlKey still finds its header when a quoted header precedes it", () => {
  const text = [
    '[projects."/Users/alice/My Project"]',
    'trust_level = "trusted"',
    "",
    "[mcp_servers.pluriply]",
    'command = "node"',
  ].join("\n");
  const r = insertTomlKey(
    text,
    "mcp_servers.pluriply",
    "tool_timeout_sec",
    "600",
  );
  assert.equal(r.changed, true);
  assert.match(
    r.text,
    /\[mcp_servers\.pluriply\]\ntool_timeout_sec = 600\ncommand = "node"/,
  );
  // 따옴표 헤더는 이름 그대로 다른 섹션이다 — 본문이 그대로 남아야 한다.
  assert.match(
    r.text,
    /\[projects\."\/Users\/alice\/My Project"\]\ntrust_level/,
  );
});
