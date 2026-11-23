import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasHint, markHint } from "../../src/shared/hints.js";

function tmpHome(t) {
  const home = mkdtempSync(join(tmpdir(), "plp-view-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("hints are recorded once and preserved", (t) => {
  const home = tmpHome(t);
  assert.equal(hasHint(home, "view"), false);
  markHint(home, "view", new Date("2026-11-23T01:02:03.000Z"));
  assert.equal(hasHint(home, "view"), true);
  const doc = JSON.parse(readFileSync(join(home, "hints.json"), "utf8"));
  assert.equal(doc.view, "2026-11-23T01:02:03.000Z");

  writeFileSync(join(home, "hints.json"), '{"other":"x"}');
  markHint(home, "view");
  const merged = JSON.parse(readFileSync(join(home, "hints.json"), "utf8"));
  assert.equal(merged.other, "x");
  assert.match(merged.view, /^\d{4}-\d\d-\d\dT/);
});

test("hints tolerate a corrupt file", (t) => {
  const home = tmpHome(t);
  writeFileSync(join(home, "hints.json"), "{not json");
  assert.equal(hasHint(home, "view"), false);
  assert.doesNotThrow(() => markHint(home, "view"));
  assert.equal(hasHint(home, "view"), true);
});
