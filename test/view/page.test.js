import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { makeReconnect, DOWN_AFTER } from "../../src/view/static/reconnect.js";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/view/static",
);
const read = (f) => readFileSync(join(dir, f), "utf8");

test("page scripts never assign html", () => {
  for (const f of ["app.js", "markdown.js", "reconnect.js"]) {
    const src = read(f);
    for (const bad of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "eval(",
      "new Function",
    ]) {
      assert.ok(!src.includes(bad), `${f} must not contain ${bad}`);
    }
  }
});

test("page loads only local assets", () => {
  for (const f of ["index.html", "app.css", "app.js", "reconnect.js"]) {
    const src = read(f);
    for (const bad of ["http://", "https://", "//cdn"]) {
      assert.ok(!src.includes(bad), `${f} must not contain ${bad}`);
    }
  }
});

test("page sends the key header and reads the hash", () => {
  const src = read("app.js");
  assert.ok(src.includes('"X-Pluriply-View-Key"'));
  assert.ok(src.includes("location.hash"));
  assert.ok(src.includes("replaceState"));
  assert.ok(!src.includes("EventSource"));
});

test("page builds the search box before the channel list", () => {
  const src = read("app.js");
  const i = src.indexOf('replaceChildren(el("div", "label", L.channels)');
  assert.ok(i >= 0);
  const call = src.slice(i, i + 120);
  assert.ok(call.indexOf("search") < call.indexOf("chlist"));
  assert.ok(src.includes("if (!list) return"));
  assert.ok(!src.includes('$("side").replaceChildren();'));
});

test("page shows a disconnected banner and keeps retrying", () => {
  const src = read("app.js");
  assert.ok(
    src.includes(
      'down: "연결이 끊겼습니다 — `npx pluriply view` 로 다시 열어 주세요"',
    ),
  );
  assert.ok(
    src.includes('down: "Disconnected — run `npx pluriply view` to reopen"'),
  );
  assert.ok(src.includes('import { makeReconnect } from "/reconnect.js"'));
  assert.ok(read("index.html").includes('id="banner"'));
  // 끊긴 동안엔 1초 경과 표시를 멈춘다
  assert.ok(src.includes("if (state.down || state.stopped) return;"));
});

test("reconnect counter shows the banner after three failures and resets on success", () => {
  assert.equal(DOWN_AFTER, 3);
  const r = makeReconnect();
  assert.equal(r.fail(), false);
  assert.equal(r.fail(), false);
  assert.equal(r.fail(), true);
  assert.equal(r.down, true);
  assert.equal(r.fail(), true); // 계속 실패해도 띠는 그대로(재시도는 계속)
  r.ok();
  assert.equal(r.fails, 0);
  assert.equal(r.down, false);
  // 성공 뒤엔 다시 세 번이 지나야 띠가 나온다
  assert.equal(r.fail(), false);
  assert.equal(r.fail(), false);
  assert.equal(r.fail(), true);
});

test("page labels hub statuses with the hub's spelling", () => {
  const src = read("app.js");
  assert.ok(!src.includes("canceled"));
  assert.equal(src.match(/cancelled: "/g)?.length, 2);
  assert.ok(src.includes("Object.hasOwn(L.status, s)"));
});

test("page opens the stream before taking the snapshot", () => {
  const src = read("app.js");
  const run = src.slice(src.indexOf("async function run()"));
  assert.ok(!run.includes('api("/api/snapshot")'));
  const hello = src.indexOf('if (name === "hello")');
  assert.ok(hello >= 0);
  assert.ok(src.indexOf('api("/api/snapshot")', hello) > hello);
});

test("page re-renders the main pane only for the selected channel", () => {
  const src = read("app.js");
  assert.ok(
    src.includes(
      "if (data.code === state.selected || state.selected !== before) renderMain();",
    ),
  );
});
