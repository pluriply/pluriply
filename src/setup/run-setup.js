import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENTS, makeEnv } from "./clients.js";
import { saveConfig, TEMPLATE_AGENTS } from "../hub/index.js";
import { ensureHub } from "../connector/hub-client.js";

/**
 * `pluriply setup`: 설치된 클라이언트를 감지해 pluriply 커넥터를 멱등 등록한다.
 * @param {{only?: string[], workers?: boolean, dryRun?: boolean, env?: object, home: string}} opts
 * @returns {Promise<{rows: Array<{id: string, label: string, installed: boolean, result: string}>, failed: number, hub?: {port: number}}>}
 */
export async function runSetup({ only, workers = false, dryRun = false, env, home }) {
  const e = env ?? makeEnv();
  const targets = only
    ? only.map((id) => {
        const c = CLIENTS.find((x) => x.id === id);
        if (!c) throw new Error(`unknown client: ${id} (known: ${CLIENTS.map((x) => x.id).join(", ")})`);
        return c;
      })
    : CLIENTS;
  const rows = [];
  let failed = 0;
  const enabledAgents = [];
  for (const c of targets) {
    const det = c.detect(e);
    if (!det.installed) {
      rows.push({ id: c.id, label: c.label, installed: false, result: "not installed" });
      continue;
    }
    let result;
    if (dryRun) {
      const st = c.status(e);
      result = st === "present" ? "present" : typeof st === "object" ? `failed: ${st.error}` : "planned";
    } else {
      result = c.register(e);
      if (result === "failed") result = "failed: see hint above";
    }
    if (result.startsWith("failed")) failed++;
    else if (c.kind === "cli" && TEMPLATE_AGENTS.includes(c.agent)) enabledAgents.push(c.agent);
    rows.push({ id: c.id, label: c.label, installed: true, result });
  }
  if (workers && !dryRun && enabledAgents.length > 0) enableWorkers(home, enabledAgents);
  const out = { rows, failed, workers: workers ? enabledAgents : [] };
  if (!dryRun) {
    try {
      out.hub = { port: (await ensureHub({ home })).port };
    } catch (err) {
      out.hubError = err.message;
    }
  }
  return out;
}

/** bin/pluriply.js `worker enable` 과 같은 병합 규칙: 원본 문서를 보존하고 workers 만 갱신 */
function enableWorkers(home, agents) {
  const file = join(home, "config.json");
  let rawDoc = {};
  if (existsSync(file)) {
    try {
      rawDoc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      rawDoc = {};
    }
  }
  if (!rawDoc || typeof rawDoc !== "object" || Array.isArray(rawDoc)) rawDoc = {};
  const workers = { ...(rawDoc.workers ?? {}) };
  for (const a of agents) workers[a] = { ...(workers[a] ?? {}), enabled: true };
  saveConfig(home, { ...rawDoc, workers });
}

/** @param {Awaited<ReturnType<typeof runSetup>>} r @returns {string[]} 사람이 읽는 표 */
export function formatSetup(r, { workers = false } = {}) {
  const lines = r.rows.map((row) => `${row.id.padEnd(16)} ${row.installed ? "installed    " : "not installed"} ${row.result}`);
  if (r.hub) lines.push(`hub: running on port ${r.hub.port}`);
  if (r.hubError) lines.push(`hub: could not start (${r.hubError})`);
  if (r.workers.length) lines.push(`workers enabled: ${r.workers.join(", ")}`);
  else if (!workers) {
    const cli = r.rows.filter((x) => x.installed && TEMPLATE_AGENTS.includes(x.id)).map((x) => x.id);
    if (cli.length) lines.push(`hint: run \`pluriply worker enable <${cli.join("|")}>\` to let the hub run that tool headlessly (or re-run setup --workers)`);
  }
  return lines;
}
