import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  saveConfig,
  setWorkerEnabled,
  workerEnabled,
  DEFAULT_LIMITS,
} from "../../src/shared/config.js";

test("loadConfig defaults when the file is missing or corrupt", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-"));
  const defaults = { workers: {}, limits: DEFAULT_LIMITS, allowedRoots: [] };
  assert.deepEqual(loadConfig(home), defaults);
  writeFileSync(join(home, "config.json"), "not-json{");
  assert.deepEqual(loadConfig(home), defaults);
  writeFileSync(join(home, "config.json"), "[]");
  assert.deepEqual(loadConfig(home), defaults);
});

test("loadConfig keeps only absolute-path strings from allowedRoots", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-"));
  assert.deepEqual(loadConfig(home).allowedRoots, []);

  saveConfig(home, { allowedRoots: ["/abs/one", "/abs/two"] });
  assert.deepEqual(loadConfig(home).allowedRoots, ["/abs/one", "/abs/two"]);

  saveConfig(home, {
    allowedRoots: ["relative/path", 42, null, "/abs/three"],
  });
  assert.deepEqual(loadConfig(home).allowedRoots, ["/abs/three"]);

  saveConfig(home, { allowedRoots: "not-an-array" });
  assert.deepEqual(loadConfig(home).allowedRoots, []);
});

test("loadConfig merges limits and reports enabled workers", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-"));
  saveConfig(home, {
    workers: { codex: { enabled: true }, "claude-code": { enabled: false } },
    limits: { maxDepth: 3 },
  });
  const cfg = loadConfig(home);
  assert.equal(cfg.limits.maxDepth, 3);
  assert.equal(cfg.limits.timeoutMs, DEFAULT_LIMITS.timeoutMs);
  assert.equal(workerEnabled(cfg, "codex"), true);
  assert.equal(workerEnabled(cfg, "claude-code"), false);
  assert.equal(workerEnabled(cfg, "gemini"), false);
  assert.match(readFileSync(join(home, "config.json"), "utf8"), /"codex"/);
});

test("loadConfig defaults maxQueuedPerAgent to 10 and allows overriding it", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-"));
  assert.equal(loadConfig(home).limits.maxQueuedPerAgent, 10);
  assert.equal(DEFAULT_LIMITS.maxQueuedPerAgent, 10);

  saveConfig(home, { limits: { maxQueuedPerAgent: 3 } });
  assert.equal(loadConfig(home).limits.maxQueuedPerAgent, 3);
});

test("setWorkerEnabled merges into workers only, preserves other keys, and starts from {} on corrupt input", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-"));
  setWorkerEnabled(home, ["codex"], true);
  let doc = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.deepEqual(doc, { workers: { codex: { enabled: true } } });

  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      allowedRoots: ["/abs"],
      limits: { maxDepth: 5 },
      workers: { codex: { enabled: true, extra: 1 } },
    }),
  );
  setWorkerEnabled(home, ["antigravity", "codex"], true);
  doc = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.deepEqual(doc.allowedRoots, ["/abs"]);
  assert.equal(doc.limits.maxDepth, 5);
  assert.deepEqual(doc.workers.codex, { enabled: true, extra: 1 });
  assert.deepEqual(doc.workers.antigravity, { enabled: true });

  setWorkerEnabled(home, ["codex"], false);
  doc = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(doc.workers.codex, undefined);
  assert.deepEqual(doc.workers.antigravity, { enabled: true });
  assert.deepEqual(doc.allowedRoots, ["/abs"]);

  writeFileSync(join(home, "config.json"), "not-json{");
  setWorkerEnabled(home, ["codex"], true);
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, "config.json"), "utf8")),
    { workers: { codex: { enabled: true } } },
  );
  writeFileSync(join(home, "config.json"), JSON.stringify({ workers: [1] }));
  setWorkerEnabled(home, ["codex"], true);
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, "config.json"), "utf8")),
    { workers: { codex: { enabled: true } } },
  );
  setWorkerEnabled(home, [], false);
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, "config.json"), "utf8")),
    { workers: { codex: { enabled: true } } },
  );
});

test("setWorkerEnabled creates the home directory when it does not exist yet (fresh install, hub never started)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plp-"));
  const home = join(tmp, "nonexistent");
  assert.equal(existsSync(home), false);
  setWorkerEnabled(home, ["codex"], true);
  assert.equal(existsSync(home), true);
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, "config.json"), "utf8")),
    { workers: { codex: { enabled: true } } },
  );
});
