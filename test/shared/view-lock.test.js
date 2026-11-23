import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readViewLock,
  writeViewLock,
  removeViewLockIf,
} from "../../src/shared/view-lock.js";

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), "plp-view-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("view lock round trip", (t) => {
  const home = tempHome(t);
  assert.equal(readViewLock(home), null);
  const doc = {
    pid: 4242,
    port: 50123,
    key: "a".repeat(64),
    startedAt: "2026-11-23T00:00:00.000Z",
    version: "0.13.1",
  };
  writeViewLock(home, doc);
  assert.deepEqual(readViewLock(home), doc);
  // tmp 파일이 남지 않는다
  assert.deepEqual(readdirSync(home), ["view.json"]);
  if (process.platform !== "win32")
    assert.equal(statSync(join(home, "view.json")).mode & 0o777, 0o600);

  // 주인이 아니면(port 다름) 지우지 않는다
  assert.equal(removeViewLockIf(home, { pid: 4242, port: 50124 }), false);
  assert.equal(removeViewLockIf(home, { pid: 4243, port: 50123 }), false);
  assert.ok(existsSync(join(home, "view.json")));
  assert.equal(removeViewLockIf(home, { pid: 4242, port: 50123 }), true);
  assert.equal(existsSync(join(home, "view.json")), false);
  assert.equal(removeViewLockIf(home, { pid: 4242, port: 50123 }), false);

  // 손상·형식이 틀린 잠금은 null
  writeFileSync(join(home, "view.json"), "{");
  assert.equal(readViewLock(home), null);
  writeFileSync(
    join(home, "view.json"),
    JSON.stringify({ pid: "1", port: 2, key: "k" }),
  );
  assert.equal(readViewLock(home), null);
  writeFileSync(join(home, "view.json"), JSON.stringify({ pid: 1, port: 2 }));
  assert.equal(readViewLock(home), null);
  // 손상된 잠금은 지우지 않는다(주인을 가릴 수 없다)
  assert.equal(removeViewLockIf(home, { pid: 1, port: 2 }), false);
  assert.ok(existsSync(join(home, "view.json")));
});
