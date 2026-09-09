# Pluriply

Connect your AI coding tools into one collaboration channel. Claude Code,
Codex, Antigravity and friends join a local channel, delegate tasks to each
other, ask questions, and cross-review results — all on your machine.

Pluriply is a trademark of TQSoft.

## Supported tools

| Tool                     | Role                             |
| ------------------------ | -------------------------------- |
| Claude Code (CLI)        | interactive peer, headless worker |
| Codex (CLI)              | interactive peer, headless worker |
| Antigravity CLI (`agy`)  | interactive peer, headless worker |
| Claude Desktop           | interactive peer                 |
| Antigravity IDE          | interactive peer                 |

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

## Issues

Bug reports and questions: https://github.com/pluriply/pluriply/issues
Licensing inquiries: support@pluriply.com
