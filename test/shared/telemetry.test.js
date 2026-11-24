import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  symlinkSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { markHint, hasHint } from "../../src/shared/hints.js";
import { skipUnlessSymlinks } from "../fixtures/platform.js";
import {
  TELEMETRY_URL,
  KNOWN_TOOLS,
  MIN_GAP_MS,
  readState,
  writeState,
  disabledReason,
  setEnabled,
  noteTool,
  noteViewOpened,
  buildPayload,
  maybeSend,
  noteEnvOptOut,
  printTelemetryNotice,
  TELEMETRY_NOTICE,
} from "../../src/shared/telemetry.js";

function tmpHome(t) {
  const home = mkdtempSync(join(tmpdir(), "plp-tel-"));
  const tmpRoot = mkdtempSync(join(tmpdir(), "plp-telroot-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  });
  return { home, tmpRoot };
}

// 임시 홈은 temp-home 으로 막히므로 URL 덮어쓰기(수동 시험 경로)로 푼다
const OVERRIDE = { PLURIPLY_TELEMETRY_URL: "http://localhost:1/ping" };
const NOW = new Date("2026-11-24T12:00:00.000Z");
const ago = (h) => new Date(NOW.getTime() - h * 3600_000);
const notified = (home) => markHint(home, "telemetry", NOW);
const stateFile = (home) => join(home, "telemetry.json");

test("constants", () => {
  assert.equal(TELEMETRY_URL, "https://t.pluriply.com/v1/ping");
  assert.deepEqual(KNOWN_TOOLS, ["claude-code", "codex", "antigravity"]);
  assert.equal(MIN_GAP_MS, 20 * 3600_000);
});

test("disabledReason ignoreNotice skips only the not-notified check", (t) => {
  const { home, tmpRoot } = tmpHome(t);
  const o = { home, tmpRoot, ignoreNotice: true };
  assert.equal(disabledReason({ ...o, env: {} }), null);
  assert.equal(
    disabledReason({ ...o, env: { PLURIPLY_TELEMETRY: "0" } }),
    "env",
  );
  assert.equal(
    disabledReason({ ...o, env: { DO_NOT_TRACK: "1" } }),
    "do-not-track",
  );
  assert.equal(disabledReason({ ...o, env: { CI: "true" } }), "ci");
});

test("disabledReason follows the documented order", (t) => {
  const { home, tmpRoot } = tmpHome(t);
  assert.equal(disabledReason({ home, env: {}, tmpRoot }), "not-notified");
  notified(home);
  assert.equal(disabledReason({ home, env: {}, tmpRoot }), null);
  assert.equal(
    disabledReason({ home, env: { PLURIPLY_TELEMETRY: "OFF" }, tmpRoot }),
    "env",
  );
  assert.equal(
    disabledReason({ home, env: { DO_NOT_TRACK: "1" }, tmpRoot }),
    "do-not-track",
  );
  assert.equal(disabledReason({ home, env: { CI: "true" }, tmpRoot }), "ci");
  assert.equal(disabledReason({ home, env: { CI: "" }, tmpRoot }), null);
  setEnabled(home, false);
  assert.equal(disabledReason({ home, env: {}, tmpRoot }), "turned-off");
  setEnabled(home, true);
  assert.equal(disabledReason({ home, env: {}, tmpRoot }), null);
});

test("disabledReason: home under tmpRoot is temp-home unless URL override", (t) => {
  const { tmpRoot } = tmpHome(t);
  const home = join(tmpRoot, "inner");
  mkdirSync(home);
  notified(home);
  assert.equal(disabledReason({ home, env: {}, tmpRoot }), "temp-home");
  assert.equal(
    disabledReason({
      home,
      env: { PLURIPLY_TELEMETRY_URL: "http://localhost:1/x" },
      tmpRoot,
    }),
    null,
  );
});

test("buildPayload counts 24h tasks, tools, and exposes only allowed keys", (t) => {
  const { home } = tmpHome(t);
  mkdirSync(join(home, "channels"));
  const mk = (status, h) => ({ status, createdAt: ago(h).toISOString() });
  writeFileSync(
    join(home, "channels", "plp-abcd-efgh.json"),
    JSON.stringify({
      code: "plp-abcd-efgh",
      tasks: [
        mk("completed", 1),
        mk("failed", 2),
        mk("submitted", 3),
        mk("completed", 25),
        mk("cancelled", 4),
      ],
    }),
  );
  noteTool(home, "codex", NOW);
  noteTool(home, "weird", NOW);
  noteTool(home, "claude-code", ago(25));
  noteViewOpened(home, NOW);
  const p = buildPayload({
    home,
    now: NOW,
    version: "9.9.9",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "22.3.1",
  });
  assert.deepEqual(p.last24h, {
    sent: 4,
    completed: 1,
    failed: 1,
    viewOpened: 1,
  });
  assert.deepEqual(p.tools, ["codex", "other"]);
  assert.equal(p.os, "darwin-arm64");
  assert.equal(p.node, 22);
  assert.equal(p.schema, 1);
  assert.equal(p.id, null);
  assert.deepEqual(Object.keys(p).sort(), [
    "id",
    "last24h",
    "node",
    "os",
    "schema",
    "tools",
    "version",
  ]);
  const json = JSON.stringify(p);
  assert.ok(!json.includes(home));
  assert.ok(!json.includes("plp-abcd-efgh"));
});

test("noteViewOpened keeps only the last 48h", (t) => {
  const { home } = tmpHome(t);
  noteViewOpened(home, ago(49));
  for (let i = 0; i < 3; i++) noteViewOpened(home, NOW);
  const doc = JSON.parse(
    readFileSync(join(home, "telemetry-counts.json"), "utf8"),
  );
  assert.equal(doc.viewOpened.length, 3);
  const p = buildPayload({ home, now: NOW, version: "1.0.0" });
  assert.equal(p.last24h.viewOpened, 3);
});

test("maybeSend: disabled makes no fetch", async (t) => {
  const { home } = tmpHome(t);
  let calls = 0;
  const fetchImpl = async () => (calls++, { ok: true, status: 204 });
  const r = await maybeSend({
    home,
    now: NOW,
    env: OVERRIDE,
    version: "1",
    fetchImpl,
  });
  assert.deepEqual(r, { sent: false, reason: "not-notified" });
  assert.equal(calls, 0);
});

test("maybeSend: sends once, records, then recent", async (t) => {
  const { home } = tmpHome(t);
  notified(home);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 204 };
  };
  const base = {
    home,
    env: OVERRIDE,
    version: "1.2.3",
    fetchImpl,
    url: "http://x/y",
  };
  const r = await maybeSend({ ...base, now: NOW });
  assert.deepEqual(r, { sent: true, reason: "ok" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://x/y");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.match(
    body.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(readState(home).lastSentAt, NOW.toISOString());
  if (process.platform !== "win32")
    assert.equal(statSync(stateFile(home)).mode & 0o777, 0o600);

  const r2 = await maybeSend({ ...base, now: new Date(NOW.getTime() + 1000) });
  assert.deepEqual(r2, { sent: false, reason: "recent" });
  assert.equal(calls.length, 1);

  const r3 = await maybeSend({
    ...base,
    now: new Date(NOW.getTime() + MIN_GAP_MS),
  });
  assert.equal(r3.sent, true);
  assert.equal(readState(home).id, body.id);
});

test("maybeSend: future lastSentAt is ignored", async (t) => {
  const { home } = tmpHome(t);
  notified(home);
  writeState(home, {
    toolsSeen: {},
    lastSentAt: new Date(NOW.getTime() + 3600_000).toISOString(),
  });
  let calls = 0;
  const fetchImpl = async () => (calls++, { ok: true, status: 204 });
  const r = await maybeSend({
    home,
    now: NOW,
    env: OVERRIDE,
    version: "1",
    fetchImpl,
    url: "u",
  });
  assert.equal(r.sent, true);
  assert.equal(calls, 1);
});

test("maybeSend: failures never throw and keep lastSentAt", async (t) => {
  const { home } = tmpHome(t);
  notified(home);
  const base = { home, now: NOW, env: OVERRIDE, version: "1", url: "u" };
  const r1 = await maybeSend({
    ...base,
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(r1, { sent: false, reason: "error" });
  assert.equal(readState(home).lastSentAt, undefined);
  const r2 = await maybeSend({
    ...base,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.deepEqual(r2, { sent: false, reason: "http-500" });
  assert.equal(readState(home).lastSentAt, undefined);
});

test("setEnabled(false) drops id and lastSentAt", async (t) => {
  const { home } = tmpHome(t);
  notified(home);
  await maybeSend({
    home,
    now: NOW,
    env: OVERRIDE,
    version: "1",
    url: "u",
    fetchImpl: async () => ({ ok: true, status: 204 }),
  });
  assert.ok(readState(home).id);
  setEnabled(home, false);
  const s = readState(home);
  assert.equal(s.id, undefined);
  assert.equal(s.lastSentAt, undefined);
  assert.equal(s.enabled, false);
});

test("corrupt files fall back to defaults without throwing", async (t) => {
  for (const junk of ["not json", "[]"]) {
    const { home } = tmpHome(t);
    notified(home);
    mkdirSync(join(home, "channels"));
    writeFileSync(stateFile(home), junk);
    writeFileSync(join(home, "telemetry-counts.json"), junk);
    writeFileSync(join(home, "channels", "plp-abcd-efgh.json"), junk);
    assert.deepEqual(readState(home), { toolsSeen: {} });
    noteViewOpened(home, NOW);
    noteTool(home, "codex", NOW);
    const p = buildPayload({ home, now: NOW, version: "1" });
    assert.deepEqual(p.last24h, {
      sent: 0,
      completed: 0,
      failed: 0,
      viewOpened: 1,
    });
    assert.deepEqual(p.tools, ["codex"]);
    writeFileSync(stateFile(home), junk);
    writeFileSync(join(home, "telemetry-counts.json"), junk);
    assert.equal(
      disabledReason({ home, env: OVERRIDE, tmpRoot: "/nonexistent-root" }),
      null,
    );
    const r = await maybeSend({
      home,
      now: NOW,
      env: OVERRIDE,
      version: "1",
      url: "u",
      fetchImpl: async () => ({ ok: true, status: 204 }),
    });
    assert.equal(r.sent, true);
  }
});

test("hardening: unknown tool names in telemetry.json never reach the payload", (t) => {
  const { home } = tmpHome(t);
  writeState(home, {
    toolsSeen: { "evil/path": NOW.toISOString(), codex: NOW.toISOString() },
  });
  assert.deepEqual(buildPayload({ home, now: NOW, version: "1" }).tools, [
    "codex",
  ]);
});

test("hardening: temp-home compares real paths through symlinks", (t) => {
  const { tmpRoot } = tmpHome(t);
  if (!skipUnlessSymlinks(t, tmpRoot)) return;
  const real = join(tmpRoot, "real");
  mkdirSync(real);
  const link = join(tmpRoot, "link");
  symlinkSync(real, link);
  const home = join(realpathSync(real), "h");
  mkdirSync(home);
  notified(home);
  assert.equal(disabledReason({ home, env: {}, tmpRoot: link }), "temp-home");
});

test("hardening: note functions never throw on an unwritable home", (t) => {
  const { tmpRoot } = tmpHome(t);
  const home = join(tmpRoot, "afile");
  writeFileSync(home, "x");
  assert.doesNotThrow(() => noteTool(home, "codex", NOW));
  assert.doesNotThrow(() => noteViewOpened(home, NOW));
});

const offFile = (home) => join(home, "telemetry-off");
const okFetch = (ids) => async (url, init) => {
  ids.push(JSON.parse(init.body).id);
  return { ok: true, status: 204 };
};

test("off marker: a stale state write after off (race) cannot turn telemetry back on", async (t) => {
  const { home, tmpRoot } = tmpHome(t);
  notified(home);
  const ids = [];
  const base = {
    home,
    env: OVERRIDE,
    version: "1",
    url: "u",
    fetchImpl: okFetch(ids),
  };
  await maybeSend({ ...base, now: NOW });
  assert.equal(ids.length, 1);
  // 다른 프로세스(허브의 noteTool 등)가 off 전에 읽은 상태를 off 뒤에 쓴다
  const stale = readState(home);
  assert.ok(stale.id);
  setEnabled(home, false);
  assert.ok(statSync(offFile(home)).isFile(), "off writes a marker file");
  assert.ok(!Number.isNaN(Date.parse(readFileSync(offFile(home), "utf8"))));
  writeState(home, { ...stale, lastSentAt: undefined });
  assert.equal(readState(home).enabled, undefined); // 상태 파일만 보면 켜진 것처럼 보인다
  assert.equal(disabledReason({ home, env: {}, tmpRoot }), "turned-off");
  const r = await maybeSend({
    ...base,
    now: new Date(NOW.getTime() + MIN_GAP_MS),
  });
  assert.deepEqual(r, { sent: false, reason: "turned-off" });
  assert.equal(ids.length, 1);
});

test("off marker: a corrupt telemetry.json with the marker is still turned-off", (t) => {
  const { home, tmpRoot } = tmpHome(t);
  notified(home);
  setEnabled(home, false);
  writeFileSync(stateFile(home), "not-json{");
  assert.equal(disabledReason({ home, env: {}, tmpRoot }), "turned-off");
});

test("off marker: a turn-off during the POST does not record lastSentAt", async (t) => {
  const { home } = tmpHome(t);
  notified(home);
  const r = await maybeSend({
    home,
    now: NOW,
    env: OVERRIDE,
    version: "1",
    url: "u",
    fetchImpl: async () => {
      const before = readState(home); // 전송 중 다른 프로세스가 읽은 상태
      setEnabled(home, false);
      writeState(home, before); // 그리고 옛 상태로 덮는다(enabled 없음)
      return { ok: true, status: 204 };
    },
  });
  assert.equal(r.sent, true);
  assert.equal(readState(home).lastSentAt, undefined);
});

test("on after off removes the marker, keeps no id until the next send, and that send uses a new id", async (t) => {
  const { home, tmpRoot } = tmpHome(t);
  notified(home);
  const ids = [];
  const base = {
    home,
    env: OVERRIDE,
    version: "1",
    url: "u",
    fetchImpl: okFetch(ids),
  };
  await maybeSend({ ...base, now: NOW });
  const stale = readState(home);
  setEnabled(home, false);
  writeState(home, stale); // 경합으로 옛 id 가 되살아나도
  setEnabled(home, true);
  assert.throws(() => statSync(offFile(home)), { code: "ENOENT" });
  const s = readState(home);
  assert.equal(s.enabled, true);
  assert.equal(s.id, undefined);
  assert.equal(s.lastSentAt, undefined);
  assert.equal(disabledReason({ home, env: {}, tmpRoot }), null);
  const r = await maybeSend({ ...base, now: new Date(NOW.getTime() + 1000) });
  assert.equal(r.sent, true);
  assert.equal(ids.length, 2);
  assert.ok(ids[1]);
  assert.notEqual(ids[1], ids[0]);
  assert.equal(readState(home).id, ids[1]);
});

test("on while already on keeps the id and lastSentAt", async (t) => {
  const { home } = tmpHome(t);
  notified(home);
  const ids = [];
  await maybeSend({
    home,
    now: NOW,
    env: OVERRIDE,
    version: "1",
    url: "u",
    fetchImpl: okFetch(ids),
  });
  const before = readState(home);
  assert.ok(before.id);
  setEnabled(home, true);
  setEnabled(home, true);
  const after = readState(home);
  assert.equal(after.enabled, true);
  assert.equal(after.id, before.id);
  assert.equal(after.lastSentAt, before.lastSentAt);
  assert.throws(() => statSync(offFile(home)), { code: "ENOENT" });
});

const envOffFile = (home) => join(home, "telemetry-env-off");

test("noteEnvOptOut records each env reason and nothing otherwise", (t) => {
  for (const [env, why] of [
    [{ PLURIPLY_TELEMETRY: "0" }, "env"],
    [{ PLURIPLY_TELEMETRY: "off", DO_NOT_TRACK: "1" }, "env"],
    [{ DO_NOT_TRACK: "true" }, "do-not-track"],
    [{ GITHUB_ACTIONS: "true" }, "ci"],
  ]) {
    const { home } = tmpHome(t);
    noteEnvOptOut(home, env);
    assert.equal(readFileSync(envOffFile(home), "utf8"), why);
  }
  for (const env of [
    {},
    { PLURIPLY_TELEMETRY: "1" },
    { DO_NOT_TRACK: "0" },
    { CI: "" },
  ]) {
    const { home } = tmpHome(t);
    noteEnvOptOut(home, env);
    assert.equal(existsSync(envOffFile(home)), false, JSON.stringify(env));
  }
});

test("noteEnvOptOut never throws on an unwritable home", (t) => {
  const { tmpRoot } = tmpHome(t);
  const home = join(tmpRoot, "afile");
  writeFileSync(home, "x");
  assert.doesNotThrow(() => noteEnvOptOut(home, { PLURIPLY_TELEMETRY: "0" }));
});

test("env marker survives the env var going away, and blocks sending", async (t) => {
  const { home, tmpRoot } = tmpHome(t);
  notified(home);
  noteEnvOptOut(home, { DO_NOT_TRACK: "1" });
  // 변수가 없는 환경(Codex 가 거른 허브 등)에서도 꺼져 있다
  assert.equal(disabledReason({ home, env: {}, tmpRoot }), "do-not-track");
  assert.equal(
    disabledReason({ home, env: OVERRIDE, tmpRoot, ignoreNotice: true }),
    "do-not-track",
  );
  noteEnvOptOut(home, {}); // 변수가 사라져도 지우지 않는다
  assert.ok(existsSync(envOffFile(home)));
  let calls = 0;
  const r = await maybeSend({
    home,
    now: NOW,
    env: OVERRIDE,
    version: "1",
    url: "u",
    fetchImpl: async () => (calls++, { ok: true, status: 204 }),
  });
  assert.deepEqual(r, { sent: false, reason: "do-not-track" });
  assert.equal(calls, 0);
  // 사용자가 끈 것이 먼저다
  setEnabled(home, false);
  assert.equal(disabledReason({ home, env: {}, tmpRoot }), "turned-off");
});

test("env marker: corrupt or unknown content reads as env", (t) => {
  const { home, tmpRoot } = tmpHome(t);
  notified(home);
  for (const junk of ["", "garbage", "\u0000{"]) {
    writeFileSync(envOffFile(home), junk);
    assert.equal(disabledReason({ home, env: OVERRIDE, tmpRoot }), "env");
  }
});

test("setEnabled(true) removes the env marker and starts a new id; off keeps it", async (t) => {
  const { home, tmpRoot } = tmpHome(t);
  notified(home);
  const ids = [];
  const base = {
    home,
    env: OVERRIDE,
    version: "1",
    url: "u",
    fetchImpl: okFetch(ids),
  };
  await maybeSend({ ...base, now: NOW });
  noteEnvOptOut(home, { CI: "1" });
  setEnabled(home, false);
  assert.ok(existsSync(envOffFile(home)), "off does not clear it");
  setEnabled(home, true);
  assert.equal(existsSync(envOffFile(home)), false);
  assert.equal(disabledReason({ home, env: OVERRIDE, tmpRoot }), null);
  // 환경 끄기 기억만 있다가 on 해도 새 id 로 시작한다
  await maybeSend({ ...base, now: new Date(NOW.getTime() + 1000) });
  noteEnvOptOut(home, { PLURIPLY_TELEMETRY: "false" });
  setEnabled(home, true);
  assert.equal(readState(home).id, undefined);
  assert.equal(existsSync(envOffFile(home)), false);
  await maybeSend({ ...base, now: new Date(NOW.getTime() + 2000) });
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
});

test("buildPayload ignores future tasks and caps each count", (t) => {
  const { home } = tmpHome(t);
  mkdirSync(join(home, "channels"));
  const at = (ms) => new Date(NOW.getTime() + ms).toISOString();
  const tasks = [
    { status: "completed", createdAt: at(-1000) },
    { status: "completed", createdAt: at(60_000) }, // 미래
    { status: "failed", createdAt: at(30 * 24 * 3600_000) }, // 먼 미래
  ];
  writeFileSync(
    join(home, "channels", "plp-abcd-efgh.json"),
    JSON.stringify({ tasks }),
  );
  assert.deepEqual(buildPayload({ home, now: NOW, version: "1" }).last24h, {
    sent: 1,
    completed: 1,
    failed: 0,
    viewOpened: 0,
  });
  const many = Array.from({ length: 100_005 }, () => ({
    status: "completed",
    createdAt: at(-1000),
  }));
  writeFileSync(
    join(home, "channels", "plp-abcd-efgh.json"),
    JSON.stringify({ tasks: many }),
  );
  const p = buildPayload({ home, now: NOW, version: "1" });
  assert.equal(p.last24h.sent, 100_000);
  assert.equal(p.last24h.completed, 100_000);
  assert.equal(p.last24h.failed, 0);
});

test("maybeSend cancels the body of a non-2xx response", async (t) => {
  const { home } = tmpHome(t);
  notified(home);
  let cancelled = 0;
  const base = { home, now: NOW, env: OVERRIDE, version: "1", url: "u" };
  const r = await maybeSend({
    ...base,
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      body: { cancel: async () => cancelled++ },
    }),
  });
  assert.deepEqual(r, { sent: false, reason: "http-400" });
  assert.equal(cancelled, 1);
  // cancel 이 실패해도 결과는 같다
  const r2 = await maybeSend({
    ...base,
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      body: {
        cancel: async () => {
          throw new Error("x");
        },
      },
    }),
  });
  assert.deepEqual(r2, { sent: false, reason: "http-503" });
});

test("printTelemetryNotice records the hint only when mark is true", (t) => {
  const { home } = tmpHome(t);
  assert.deepEqual(printTelemetryNotice(home, { mark: false }), [
    "",
    TELEMETRY_NOTICE,
  ]);
  assert.equal(hasHint(home, "telemetry"), false);
  assert.deepEqual(printTelemetryNotice(home), ["", TELEMETRY_NOTICE]);
  assert.equal(hasHint(home, "telemetry"), true);
  assert.deepEqual(printTelemetryNotice(home, { mark: false }), []);
});
