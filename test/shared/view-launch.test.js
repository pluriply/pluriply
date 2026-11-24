import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startViewServer } from "../../src/view/server.js";
import { readViewLock, writeViewLock } from "../../src/shared/view-lock.js";
import { hasHint } from "../../src/shared/hints.js";
import { pidAlive } from "../../src/shared/probe.js";
import { PACKAGE_VERSION } from "../../src/shared/version.js";
import {
  ensureView,
  stopView,
  viewUrl,
  viewHealth,
  serveSpawnOptions,
  VIEW_HINT_LINE,
} from "../../src/shared/view-launch.js";

/** 임시 홈 + 띄운 서버 정리(한 훅에서 서버 → 홈 순서) */
function ctx(t) {
  const home = mkdtempSync(join(tmpdir(), "plp-view-"));
  const servers = [];
  t.after(async () => {
    for (const s of servers) await s.close("test").catch(() => {});
    rmSync(home, { recursive: true, force: true });
  });
  const start = async (opts = {}) => {
    const s = await startViewServer({
      home,
      fetchSessions: async () => null,
      ...opts,
    });
    servers.push(s);
    return s;
  };
  return { home, start };
}

test("the detached view server runs in the pluriply home, not the caller's folder", () => {
  const o = serveSpawnOptions("/tmp/plp-home");
  assert.equal(o.cwd, "/tmp/plp-home");
  assert.equal(o.env.PLURIPLY_HOME, "/tmp/plp-home");
  assert.equal(o.detached, true);
  assert.equal(o.stdio, "ignore");
  assert.equal(o.windowsHide, true);
});

test("hint line text", () => {
  assert.equal(VIEW_HINT_LINE, "See it on screen: npx pluriply view");
});

test("ensureView spawns, waits and opens", async (t) => {
  const { home, start } = ctx(t);
  const opened = [];
  const r = await ensureView({
    home,
    spawnServe: () => void start(),
    openBrowser: (url) => (opened.push(url), true),
  });
  assert.equal(r.reused, false);
  assert.equal(r.opened, true);
  assert.equal(r.url, viewUrl(readViewLock(home)));
  assert.deepEqual(opened, [r.url]);
  assert.equal(hasHint(home, "view"), true);
  assert.equal(existsSync(join(home, "view-spawn.lock")), false);
});

test("ensureView reuses a healthy same-version server", async (t) => {
  const { home, start } = ctx(t);
  let spawned = 0;
  const spawnServe = () => {
    spawned++;
    void start();
  };
  const first = await ensureView({ home, spawnServe, openBrowser: () => true });
  const again = await ensureView({ home, spawnServe, openBrowser: () => true });
  assert.equal(spawned, 1);
  assert.equal(again.reused, true);
  assert.equal(again.url, first.url);
});

test("ensureView spawns once for concurrent callers", async (t) => {
  const { home, start } = ctx(t);
  let spawned = 0;
  const spawnServe = () => {
    spawned++;
    void start();
  };
  const [a, b] = await Promise.all([
    ensureView({ home, spawnServe, openBrowser: () => true }),
    ensureView({ home, spawnServe, openBrowser: () => true }),
  ]);
  assert.equal(spawned, 1);
  assert.equal(a.url, b.url);
});

test("ensureView replaces a different-version server", async (t) => {
  const { home, start } = ctx(t);
  const old = await start({ version: "0.0.1" });
  let stops = 0;
  const r = await ensureView({
    home,
    version: PACKAGE_VERSION,
    spawnServe: () => void start({ version: PACKAGE_VERSION }),
    stop: async () => (stops++, await old.close("stopped"), "stopped"),
    openBrowser: () => true,
  });
  assert.equal(stops, 1);
  assert.equal(await old.closed, "stopped");
  assert.equal(readViewLock(home).version, PACKAGE_VERSION);
  assert.equal(r.reused, false);
});

test("ensureView reports a browser that did not open", async (t) => {
  const { home, start } = ctx(t);
  const r = await ensureView({
    home,
    spawnServe: () => void start(),
    openBrowser: () => false,
  });
  assert.equal(r.opened, false);
});

test("ensureView does not open the browser when open is false", async (t) => {
  const { home, start } = ctx(t);
  let calls = 0;
  const r = await ensureView({
    home,
    open: false,
    spawnServe: () => void start(),
    openBrowser: () => (calls++, true),
  });
  assert.equal(calls, 0);
  assert.equal(r.opened, false);
});

test("ensureView times out when no server comes up", async (t) => {
  const { home } = ctx(t);
  await assert.rejects(
    ensureView({
      home,
      spawnServe: () => {},
      timeoutMs: 300,
      openBrowser: () => true,
    }),
    /pluriply view did not start within/,
  );
  assert.equal(existsSync(join(home, "view-spawn.lock")), false);
});

test("ensureView waits for a fresh spawn lock and takes over an old one", async (t) => {
  const { home, start } = ctx(t);
  // 막 만들어진 잠금: 남이 띄우는 중이므로 spawn 하지 않고 기다리다 기한을 넘긴다
  writeFileSync(join(home, "view-spawn.lock"), "");
  let spawned = 0;
  await assert.rejects(
    ensureView({
      home,
      spawnServe: () => spawned++,
      timeoutMs: 300,
      openBrowser: () => true,
    }),
    /did not start/,
  );
  assert.equal(spawned, 0);
  // 10초 넘은 잠금은 지우고 잡는다
  const { utimesSync } = await import("node:fs");
  const old = new Date(Date.now() - 20_000);
  utimesSync(join(home, "view-spawn.lock"), old, old);
  const r = await ensureView({
    home,
    spawnServe: () => void start(),
    openBrowser: () => true,
  });
  assert.equal(r.reused, false);
});

test("viewHealth answers for a live server and null otherwise", async (t) => {
  const { home, start } = ctx(t);
  const s = await start();
  const h = await viewHealth(readViewLock(home));
  assert.equal(h.ok, true);
  assert.equal(h.version, PACKAGE_VERSION);
  await s.close("test");
  assert.equal(await viewHealth({ port: s.port, key: s.key }, 300), null);
});

/** 끝난 자식 프로세스의 pid — 지금 살아 있지 않다고 확실한 값 */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => child.once("exit", r));
  return child.pid;
}

test("stopView clears a stale lock", async (t) => {
  const { home } = ctx(t);
  const dead = await deadPid();
  assert.equal(pidAlive(dead), false);
  assert.equal(await stopView({ home }), "not-running");
  writeViewLock(home, {
    pid: dead,
    port: 1,
    key: "k",
    startedAt: "x",
    version: "0",
  });
  assert.equal(await stopView({ home }), "not-running");
  assert.equal(existsSync(join(home, "view.json")), false);
});

test("stopView leaves a live unrelated process alone when the port refuses", async (t) => {
  const { home } = ctx(t);
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));
  // 거부하는 포트: 잠깐 열었다 닫는다
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  writeViewLock(home, {
    pid: child.pid,
    port,
    key: "k",
    startedAt: "x",
    version: "0",
  });
  assert.equal(await stopView({ home, timeoutMs: 1500 }), "not-running");
  assert.equal(pidAlive(child.pid), true);
  assert.equal(existsSync(join(home, "view.json")), false);
});

test("stopView returns unresponsive without killing or unlocking when the port accepts but never answers", async (t) => {
  const { home } = ctx(t);
  const srv = net.createServer((sock) => sock.on("error", () => {}));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  writeViewLock(home, {
    pid: process.pid,
    port: srv.address().port,
    key: "k",
    startedAt: "x",
    version: "0",
  });
  assert.equal(await stopView({ home, timeoutMs: 800 }), "unresponsive");
  assert.ok(existsSync(join(home, "view.json")));
});

test("ensureView records one view opening for telemetry", async (t) => {
  const { home, start } = ctx(t);
  await ensureView({
    home,
    spawnServe: () => void start(),
    openBrowser: () => true,
  });
  const counts = JSON.parse(
    readFileSync(join(home, "telemetry-counts.json"), "utf8"),
  );
  assert.equal(counts.viewOpened.length, 1);
});
