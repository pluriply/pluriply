import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLock } from "../../src/shared/lock.js";

function homeWith(doc) {
  const home = mkdtempSync(join(tmpdir(), "plp-lock-"));
  writeFileSync(join(home, "hub.json"), JSON.stringify(doc));
  return home;
}

test("readLock passes a string token through and drops anything else", () => {
  const tok = "a".repeat(64);
  assert.deepEqual(readLock(homeWith({ pid: 1, port: 2, token: tok })), {
    pid: 1,
    port: 2,
    token: tok,
  });
  // 구버전 허브의 락: 필드가 없다
  assert.deepEqual(readLock(homeWith({ pid: 1, port: 2 })), {
    pid: 1,
    port: 2,
  });
  // 문자열이 아닌 token 은 없는 것으로 본다
  assert.deepEqual(readLock(homeWith({ pid: 1, port: 2, token: 42 })), {
    pid: 1,
    port: 2,
  });
  assert.deepEqual(readLock(homeWith({ pid: 1, port: 2, token: "" })), {
    pid: 1,
    port: 2,
  });
});

test("readLock still rejects a lock without integer pid/port", () => {
  assert.equal(readLock(homeWith({ pid: "1", port: 2, token: "x" })), null);
  assert.equal(readLock(mkdtempSync(join(tmpdir(), "plp-lock-"))), null);
});
