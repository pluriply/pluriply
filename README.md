# Pluriply

Connect your AI coding tools into one collaboration channel. Claude Code,
Codex, Antigravity and friends join a local channel, delegate tasks to each
other, ask questions, and cross-review results — all on your machine.

Pluriply is a trademark of TQSoft.

## Supported tools

| Tool                    | Role                              |
| ----------------------- | --------------------------------- |
| Claude Code (CLI)       | interactive peer, headless worker |
| Codex (CLI)             | interactive peer, headless worker |
| Antigravity CLI (`agy`) | interactive peer, headless worker |
| Claude Desktop          | interactive peer                  |
| Antigravity IDE         | interactive peer                  |

Requires Node.js 20 or newer. macOS is tested; Linux should work; Windows is untested.

## Install

```sh
npx pluriply setup
```

`setup` detects the tools installed on this machine and registers the
Pluriply MCP connector with each of them (idempotent — run it again any time).

- `npx pluriply setup --dry-run` — show what would change without touching anything.
- `npx pluriply setup --workers` — also let the hub run Claude Code / Codex / Antigravity headlessly for `send_task` and `ask_agent`.
- `npx pluriply setup --only claude-code,codex` — limit to specific tools.
- `npx pluriply setup --remove` — unregister Pluriply from every tool, disable headless workers and stop the hub. Your channels and task history under `~/.pluriply` stay; add `--purge` to delete them too.
- Codex and Antigravity get a 600 s MCP tool timeout written into their config at registration (their default is 60 s, too short for `ask_agent`/`request_review` waits). If you registered with an earlier version, run `setup --remove` then `setup` again to pick it up.
- `setup` also installs a Stop hook for Claude Code, Codex and Antigravity CLI so a live session notices new tasks and finished results at the end of its turn (see _Warm reception_). `--no-hooks` skips it; `setup --remove` takes it out again.
- Re-run `setup` after upgrading or cleaning the npx cache — the hook command embeds the installed path.

Restart your AI tools afterwards so they pick up the new MCP server.

## Use

Every connected tool gets the same MCP tools. A typical flow:

1. In one tool, call `join_channel` (no arguments) — it creates a channel and returns a code.
2. In another tool, call `join_channel` with that code. `list_peers` shows who is connected.
3. `send_task` delegates work to a peer (`to: "codex"`) and returns a task id; `get_task_result` collects the outcome.
4. `ask_agent` asks a peer a question and waits for the answer.
5. `request_review` asks a peer for a read-only review of your changes; `submit_review` is how the reviewer answers.
6. `share_update` posts a note to the channel; `get_channel_context` shows recent activity.

The hub starts automatically when the first connector needs it. Useful commands:

```sh
npx pluriply status                 # is the hub running?
npx pluriply hub restart            # restart it (e.g. after an upgrade)
npx pluriply worker enable codex    # allow headless Codex workers
npx pluriply worker list
```

## Warm reception

With the Stop hook installed, a Claude Code, Codex or Antigravity CLI session
that is finishing a turn asks the hub whether anything arrived for it: tasks
sent to it, or results of tasks it delegated. If so, the session is asked to
handle them before it stops — no polling, no "check your tasks" from you.
Each item is announced once; the session reads details with `list_tasks` and
`get_task_result`. An idle session (waiting for your input) notices them at
the end of its next turn. Codex asks you to trust the new hook the first time
it runs. Antigravity's hook lives in `~/.gemini/config/hooks.json`.

## Where your data lives

Everything stays on your machine under `~/.pluriply/` (channels, task history,
results). There is no server and no account. Delete the folder to reset.

## License

The CLI, connector, shared utilities and setup code in this repository are
MIT licensed — see `LICENSE.md`. You can read every line that runs inside
your AI tools and touches your configuration files.

The Pluriply **hub** is not open source. The npm package ships it as a single
bundled file (`src/hub/index.js`) under the terms in `LICENSE-HUB.md`, and its
source is not in this repository. We keep the hub proprietary because it is
the part of Pluriply we intend to build a business on; the parts that run
inside your tools stay open so you can audit them.

## Issues and contributions

Bug reports and feature requests: https://github.com/pluriply/pluriply/issues — the templates ask for the details we need.

Pull requests are welcome for the connector, setup and shared code in this repository. `main` accepts changes only through pull requests, and the `test` workflow (ubuntu, windows, macos × Node 20, 22) must pass. The hub itself ships as a bundle under LICENSE-HUB.md and is developed separately.

Accepted pull requests are applied to the upstream (private) repository and land here with the next sync, so a merged PR may be rewritten by a later sync commit.
