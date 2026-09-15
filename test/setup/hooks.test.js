import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEnv } from "../../src/setup/clients.js";
import {
  HOOK_CLIENTS,
  hookCommand,
  hookStatus,
  installHook,
  removeHook,
} from "../../src/setup/hooks.js";
import { skipOnWindows } from "../fixtures/platform.js";

const BIN = "/opt/pluriply/bin/pluriply.js";
function env(homeDir, extra = {}) {
  return makeEnv({
    binPath: BIN,
    node: "/usr/bin/node",
    homeDir,
    processEnv: {},
    log: () => {},
    ...extra,
  });
}
const claude = HOOK_CLIENTS.find((h) => h.id === "claude-code");
const codex = HOOK_CLIENTS.find((h) => h.id === "codex");
const antigravity = HOOK_CLIENTS.find((h) => h.id === "antigravity");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const OTHER = {
  hooks: [{ type: "command", command: "/bin/echo other", timeout: 5 }],
};

test("HOOK_CLIENTS point at the tools' hook files and the command quotes node and bin", () => {
  const e = env("/home/u");
  assert.equal(claude.file(e), join("/home/u", ".claude", "settings.json"));
  assert.equal(codex.file(e), join("/home/u", ".codex", "hooks.json"));
  assert.equal(
    codex.file(env("/home/u", { processEnv: { CODEX_HOME: "/elsewhere" } })),
    join("/elsewhere", "hooks.json"),
  );
  assert.equal(
    hookCommand(e, "codex"),
    '"/usr/bin/node" "/opt/pluriply/bin/pluriply.js" hook stop --agent codex',
  );
});

test("installHook creates the file, merges into existing hooks preserving other groups, and is idempotent", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-hooks-"));
  const e = env(home);
  assert.equal(hookStatus(e, claude), "missing");
  assert.equal(installHook(e, claude), "registered");
  const p = claude.file(e);
  assert.deepEqual(read(p), {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: hookCommand(e, "claude-code"),
              timeout: 10,
            },
          ],
        },
      ],
    },
  });
  // 첫 설치는 새 파일을 만들 뿐이라 이전 판이 없다 — .bak 없음
  assert.equal(existsSync(`${p}.bak`), false);
  assert.equal(hookStatus(e, claude), "present");
  const before = readFileSync(p, "utf8");
  const mtimeBefore = statSync(p).mtimeMs;
  assert.equal(installHook(e, claude), "present");
  // 이미 present 면 다시 쓰지 않는다 — 내용·수정 시각 불변, .bak 도 생기지 않는다
  assert.equal(readFileSync(p, "utf8"), before);
  assert.equal(statSync(p).mtimeMs, mtimeBefore);
  assert.equal(existsSync(`${p}.bak`), false);

  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    codex.file(e),
    JSON.stringify({
      hooks: { SessionStart: [OTHER], Stop: [OTHER] },
      other: 1,
    }),
  );
  // codex 는 기존 파일(다른 그룹 포함)에 병합해 쓰는 경우라 이전 판이 .bak 로 남는다
  assert.equal(installHook(e, codex), "registered");
  assert.equal(existsSync(`${codex.file(e)}.bak`), true);
  const doc = read(codex.file(e));
  assert.equal(doc.other, 1);
  assert.deepEqual(doc.hooks.SessionStart, [OTHER]);
  assert.equal(doc.hooks.Stop.length, 2);
  assert.deepEqual(doc.hooks.Stop[0], OTHER);
  assert.match(doc.hooks.Stop[1].hooks[0].command, /hook stop --agent codex$/);
});

test("ours-detection anchors the --agent value: a longer agent name or trailing args don't match", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-hooks-"));
  const e = env(home);
  mkdirSync(join(home, ".claude"));
  const ideCmd = `"${e.node}" "${e.binPath}" hook stop --agent antigravity-ide`;
  writeFileSync(
    claude.file(e),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: ideCmd, timeout: 10 }] }],
      },
    }),
  );
  // antigravity-ide 그룹은 antigravity 것이 아니다 — 접두 일치가 아니라 정확한 끝 토큰
  assert.equal(hookStatus(e, { ...claude, id: "antigravity" }), "missing");
  // 정작 자기 자신(antigravity-ide)은 present 로 본다
  assert.equal(hookStatus(e, { ...claude, id: "antigravity-ide" }), "present");

  const trailingCmd = `"${e.node}" "${e.binPath}" hook stop --agent codex --extra`;
  writeFileSync(
    claude.file(e),
    JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: trailingCmd, timeout: 10 }] },
        ],
      },
    }),
  );
  // 뒤에 다른 인자가 더 붙은 명령은 우리 것이 아니다
  assert.equal(hookStatus(e, codex), "missing");
});

test("a stop-groups entry with our command but a non-command type is stale, not present", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-hooks-"));
  const e = env(home);
  mkdirSync(join(home, ".claude"));
  writeFileSync(
    claude.file(e),
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "x",
                command: hookCommand(e, "claude-code"),
                timeout: 10,
              },
            ],
          },
        ],
      },
    }),
  );
  assert.equal(hookStatus(e, claude), "stale");
  assert.equal(installHook(e, claude), "updated");
  const stop = read(claude.file(e)).hooks.Stop;
  assert.equal(stop[0].hooks[0].type, "command");
});

test("installHook replaces a stale entry in place when the bin path moved, and removeHook takes only ours", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-hooks-"));
  const e = env(home);
  mkdirSync(join(home, ".claude"));
  writeFileSync(
    claude.file(e),
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command:
                  '"/old/node" "/old/pluriply.js" hook stop --agent claude-code',
                timeout: 10,
              },
            ],
          },
          OTHER,
        ],
      },
    }),
  );
  assert.equal(hookStatus(e, claude), "stale");
  assert.equal(installHook(e, claude), "updated");
  let stop = read(claude.file(e)).hooks.Stop;
  assert.equal(stop.length, 2);
  assert.equal(stop[0].hooks[0].command, hookCommand(e, "claude-code"));
  assert.deepEqual(stop[1], OTHER);
  assert.equal(removeHook(e, claude), "removed");
  stop = read(claude.file(e)).hooks.Stop;
  assert.deepEqual(stop, [OTHER]);
  assert.equal(removeHook(e, claude), "absent");
  // 우리 것만 있던 파일에서는 Stop 키가 사라지고 hooks 는 남는다
  writeFileSync(
    claude.file(e),
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: hookCommand(e, "claude-code"),
                timeout: 10,
              },
            ],
          },
        ],
      },
    }),
  );
  assert.equal(removeHook(e, claude), "removed");
  assert.deepEqual(read(claude.file(e)), { hooks: {} });
  assert.equal(
    removeHook(env(mkdtempSync(join(tmpdir(), "plp-none-"))), claude),
    "absent",
  );
});

test("corrupt or JSONC hook files are reported as failed and left untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-hooks-"));
  const e = env(home);
  mkdirSync(join(home, ".codex"));
  const p = codex.file(e);
  writeFileSync(p, '{ "hooks": { /* comment */ "Stop": [] } }');
  assert.equal(typeof hookStatus(e, codex), "object");
  assert.equal(installHook(e, codex), "failed");
  assert.equal(removeHook(e, codex), "failed");
  assert.equal(
    readFileSync(p, "utf8"),
    '{ "hooks": { /* comment */ "Stop": [] } }',
  );
  writeFileSync(p, "[]");
  assert.equal(installHook(e, codex), "failed");
});

test("antigravity adapter writes a named entry with flat Stop items and removes only it", () => {
  const home = mkdtempSync(join(tmpdir(), "plp-hooks-"));
  const e = env(home);
  const ORCA = {
    Stop: [{ type: "command", command: "/bin/echo o", timeout: 10 }],
  };
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  const p = antigravity.file(e);
  writeFileSync(p, JSON.stringify({ "orca-status": ORCA }));

  assert.equal(hookStatus(e, antigravity), "missing");
  assert.equal(installHook(e, antigravity), "registered");
  let doc = read(p);
  assert.deepEqual(doc["orca-status"], ORCA);
  assert.equal(doc.pluriply.Stop.length, 1);
  assert.equal(doc.pluriply.Stop[0].command, hookCommand(e, "antigravity"));
  assert.equal(doc.pluriply.Stop[0].timeout, 10);
  assert.equal(doc.pluriply.Stop[0].type, "command");
  assert.equal(doc.pluriply.Stop[0].hooks, undefined);

  // 다시 설치해도 무변경
  assert.equal(hookStatus(e, antigravity), "present");
  assert.equal(installHook(e, antigravity), "present");

  // command 를 바꿔 두면 stale → updated
  doc = read(p);
  doc.pluriply.Stop[0].command =
    '"/old/node" "/old/pluriply.js" hook stop --agent antigravity';
  writeFileSync(p, JSON.stringify(doc));
  assert.equal(hookStatus(e, antigravity), "stale");
  assert.equal(installHook(e, antigravity), "updated");
  doc = read(p);
  assert.equal(doc.pluriply.Stop[0].command, hookCommand(e, "antigravity"));
  assert.deepEqual(doc["orca-status"], ORCA);

  // removeHook 은 pluriply 키만 지우고 다른 최상위 키는 남긴다
  assert.equal(removeHook(e, antigravity), "removed");
  doc = read(p);
  assert.equal(doc.pluriply, undefined);
  assert.deepEqual(doc["orca-status"], ORCA);
  assert.equal(removeHook(e, antigravity), "absent");

  // 파일 없음 → installHook 이 폴더(.gemini/config)를 만들고 registered
  const home2 = mkdtempSync(join(tmpdir(), "plp-hooks-"));
  const e2 = env(home2);
  assert.equal(hookStatus(e2, antigravity), "missing");
  assert.equal(installHook(e2, antigravity), "registered");
  assert.equal(existsSync(antigravity.file(e2)), true);
  assert.deepEqual(read(antigravity.file(e2)), {
    pluriply: {
      Stop: [
        {
          type: "command",
          command: hookCommand(e2, "antigravity"),
          timeout: 10,
        },
      ],
    },
  });
});

test("installHook keeps the original file mode", (t) => {
  if (skipOnWindows(t)) return;
  const home = mkdtempSync(join(tmpdir(), "plp-hooks-"));
  const e = env(home);
  mkdirSync(join(home, ".claude"));
  writeFileSync(claude.file(e), "{}");
  chmodSync(claude.file(e), 0o600);
  assert.equal(installHook(e, claude), "registered");
  assert.equal(statSync(claude.file(e)).mode & 0o777, 0o600);
});
