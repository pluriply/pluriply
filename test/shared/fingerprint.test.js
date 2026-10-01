import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeFingerprint, installRoot } from "../../src/shared/fingerprint.js";

/** 가짜 설치 루트: package.json 과 세 부품 폴더 */
function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), "plp-fp-"));
  writeFileSync(join(root, "package.json"), '{"version":"1.2.3"}');
  for (const d of ["src/hub", "src/shared", "src/connector/sub"])
    mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "src/hub/a.js"), "hub a");
  writeFileSync(join(root, "src/shared/s.js"), "shared s");
  writeFileSync(join(root, "src/connector/c.js"), "conn c");
  writeFileSync(join(root, "src/connector/sub/d.js"), "conn d");
  return root;
}

test("fingerprint is deterministic and carries the package version", () => {
  const root = fakeRoot();
  const a = codeFingerprint(root, "hub");
  const b = codeFingerprint(root, "hub");
  assert.deepEqual(a, b);
  assert.equal(a.version, "1.2.3");
  assert.match(a.fingerprint, /^[0-9a-f]{12}$/);
});

test("a part's fingerprint changes with its own files, not the other part's", () => {
  const root = fakeRoot();
  const hub0 = codeFingerprint(root, "hub").fingerprint;
  const conn0 = codeFingerprint(root, "connector").fingerprint;
  writeFileSync(join(root, "src/connector/sub/d.js"), "conn d2");
  assert.equal(codeFingerprint(root, "hub").fingerprint, hub0);
  assert.notEqual(codeFingerprint(root, "connector").fingerprint, conn0);
  writeFileSync(join(root, "src/hub/a.js"), "hub a2");
  assert.notEqual(codeFingerprint(root, "hub").fingerprint, hub0);
});

test("shared files and file names count for both parts", () => {
  const root = fakeRoot();
  const hub0 = codeFingerprint(root, "hub").fingerprint;
  const conn0 = codeFingerprint(root, "connector").fingerprint;
  writeFileSync(join(root, "src/shared/s.js"), "shared s2");
  const hub1 = codeFingerprint(root, "hub").fingerprint;
  const conn1 = codeFingerprint(root, "connector").fingerprint;
  assert.notEqual(hub1, hub0);
  assert.notEqual(conn1, conn0);
  // 내용이 같아도 이름이 바뀌면 다르다
  rmSync(join(root, "src/hub/a.js"));
  writeFileSync(join(root, "src/hub/b.js"), "hub a");
  assert.notEqual(codeFingerprint(root, "hub").fingerprint, hub1);
});

test("the package version is not part of the fingerprint (display only)", () => {
  const root = fakeRoot();
  const before = codeFingerprint(root, "hub");
  const connBefore = codeFingerprint(root, "connector");
  writeFileSync(join(root, "package.json"), '{"version":"1.2.4"}');
  const after = codeFingerprint(root, "hub");
  assert.equal(after.version, "1.2.4");
  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(
    codeFingerprint(root, "connector").fingerprint,
    connBefore.fingerprint,
  );
  // 파일 한 바이트가 바뀌면 다르다
  writeFileSync(join(root, "src/hub/a.js"), "hub b");
  assert.notEqual(codeFingerprint(root, "hub").fingerprint, before.fingerprint);
});

test("dotfiles and editor temp files under a part are ignored", () => {
  const root = fakeRoot();
  const hub0 = codeFingerprint(root, "hub").fingerprint;
  writeFileSync(join(root, "src/hub/.DS_Store"), "junk");
  writeFileSync(join(root, "src/hub/a.js~"), "junk2");
  mkdirSync(join(root, "src/hub/.git"), { recursive: true });
  writeFileSync(join(root, "src/hub/.git/x.js"), "junk3");
  assert.equal(codeFingerprint(root, "hub").fingerprint, hub0);
});

test("missing root, missing part folder or unknown part gives null", () => {
  assert.equal(
    codeFingerprint(join(tmpdir(), "plp-no-such-root"), "hub"),
    null,
  );
  const root = fakeRoot();
  rmSync(join(root, "src/hub"), { recursive: true });
  assert.equal(codeFingerprint(root, "hub"), null);
  assert.equal(codeFingerprint(root, "nope"), null);
  assert.equal(codeFingerprint(null, "hub"), null);
});

test("installRoot is the package folder of this checkout", () => {
  const expected = fileURLToPath(new URL("../..", import.meta.url)).replace(
    /[\\/]$/,
    "",
  );
  assert.equal(installRoot(), expected);
  assert.match(
    codeFingerprint(installRoot(), "connector").fingerprint,
    /^[0-9a-f]{12}$/,
  );
});
