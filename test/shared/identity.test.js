import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  isValidAgentName,
  resolveAgentName,
  makeInstanceId,
  isInstanceId,
  parseTarget,
  toolOf,
  cwdKey,
} from "../../src/shared/identity.js";
import { skipUnlessSymlinks } from "../fixtures/platform.js";

test("agent names reject #, / and whitespace", () => {
  assert.equal(isValidAgentName("claude-code"), true);
  assert.equal(isValidAgentName("codex"), true);
  assert.equal(isValidAgentName("codex#k7pq"), false);
  assert.equal(isValidAgentName("local/codex"), false);
  assert.equal(isValidAgentName("co dex"), false);
  assert.equal(isValidAgentName(""), false);
  assert.equal(isValidAgentName(undefined), false);
});

test("instance ids are <tool>#<4 chars of the id alphabet>", () => {
  assert.equal(makeInstanceId("codex", "k7pq"), "codex#k7pq");
  assert.equal(isInstanceId("codex#k7pq"), true);
  assert.equal(isInstanceId("claude-code#2abc"), true);
  assert.equal(isInstanceId("codex"), false);
  assert.equal(isInstanceId("codex#k7p"), false);
  assert.equal(isInstanceId("codex#k7pql"), false); // 'l'은 알파벳 밖, 5자
  assert.equal(isInstanceId("codex#K7PQ"), false);
  assert.equal(isInstanceId(42), false);
});

test("parseTarget splits tool-level and instance-level targets", () => {
  assert.deepEqual(parseTarget("codex"), { tool: "codex", instance: null });
  assert.deepEqual(parseTarget("codex#k7pq"), {
    tool: "codex",
    instance: "codex#k7pq",
  });
  assert.equal(toolOf("claude-code#2abc"), "claude-code");
  assert.equal(toolOf("claude-code"), "claude-code");
});

test("cwdKey is tool@8-hex and follows resolved paths", () => {
  const key = cwdKey("codex", "/tmp/proj");
  assert.match(key, /^codex@[0-9a-f]{8}$/);
  assert.equal(cwdKey("codex", "/tmp/proj/../proj"), key);
  assert.equal(cwdKey("codex", resolve("/tmp/proj")), key);
  assert.notEqual(cwdKey("codex", "/tmp/other"), key);
  assert.notEqual(cwdKey("claude-code", "/tmp/proj"), key);
});

test("cwdKey follows a symlink to the real path (macOS /var → /private/var style aliasing)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plp-identity-"));
  if (!skipUnlessSymlinks(t, dir)) return;
  const real = join(dir, "real");
  const link = join(dir, "link");
  mkdirSync(real);
  symlinkSync(real, link);
  assert.equal(cwdKey("codex", link), cwdKey("codex", real));
});

test("resolveAgentName renames antigravity to antigravity-ide only when spawned by the IDE", () => {
  const ide = {
    ANTIGRAVITY_EDITOR_APP_ROOT: "/Applications/Antigravity IDE.app",
  };
  assert.equal(resolveAgentName("antigravity", ide), "antigravity-ide");
  assert.equal(resolveAgentName("antigravity", {}), "antigravity");
  assert.equal(
    resolveAgentName("antigravity", { VSCODE_PID: "1" }),
    "antigravity",
  );
  assert.equal(resolveAgentName("codex", ide), "codex");
  assert.equal(resolveAgentName("antigravity-ide", ide), "antigravity-ide");
});
