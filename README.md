# opencode-plugin-cc

A Claude Code plugin that lets you delegate bounded, mechanical coding tasks from Claude (Opus) to [opencode](https://github.com/sst/opencode)'s cheaper secondary models — Kimi, Qwen, GLM, etc.

Opus stays as the orchestrator. Opencode does the grunt work. The long tool log stays inside the subagent's transcript, so orchestration doesn't burn your main Opus context.

## Why use it

- **Save Opus tokens.** Grunt work runs on a cheap opencode model; only the final result lands in your main context.
- **Explicit-only.** The subagent fires on `/opencode:delegate` (or when you name opencode in the request), never as a surprise for generic tasks.

## Requirements

- **opencode ≥ 1.4.10** on `PATH` — `brew install sst/tap/opencode` or `npm i -g opencode-ai`
- **Node.js ≥ 18.18**
- At least one opencode provider authenticated (`opencode auth login`)

## Install

```bash
/plugin marketplace add turygo/opencode-plugin-cc
/plugin install opencode@opencode-plugin-cc
/reload-plugins
/opencode:setup
```

## Usage

Delegate a task to opencode:

```text
/opencode:delegate add JSDoc to every exported function in src/auth/*.ts
```

Opus routes the request through the `opencode-delegate` subagent, which runs `opencode run` synchronously and returns the final output. Model selection follows your opencode config by default; pass `--model <provider/model>` to override per-call.

Run long tasks in the background:

```text
/opencode:delegate --background port the validator test suite to vitest
# → [opencode-job] id=job-abc123 status=started
/opencode:status
/opencode:result job-abc123
```

## Commands

| Command | What it does |
|---|---|
| `/opencode:delegate <task>` | Hand a task to opencode. Blocks until done, or returns a job-id with `--background`. |
| `/opencode:status [job-id]` | List or inspect background jobs. |
| `/opencode:result <job-id>` | Print the stored output of a finished job. |
| `/opencode:cancel [job-id]` | Kill an active background job. |
| `/opencode:setup` | Verify opencode is installed and authenticated. |

Flags for `/opencode:delegate`:

| Flag | Purpose |
|---|---|
| `--background` / `--wait` | Run detached and return a job-id, or block until done (default `--wait`). |
| `--model <provider/model>` | Override opencode's default model for this call. |
| `--continue` | Continue opencode's last session instead of starting fresh. |
| `--session <id>` | Resume a specific opencode session. |
| `--agent <name>` | Run under a named opencode agent. |
| `--dir <path>` | Run opencode with a different working directory. |

Everything after the flags becomes the opencode prompt.

## Security

The companion always passes `--dangerously-skip-permissions` to `opencode run` — the spawned opencode has no TTY, so TUI permission prompts can never be answered. In practice opencode has **full write and shell-exec authority in the current working directory** while a delegation runs.

Always delegate **inside a git repository** and review the diff before committing.

## License

MIT
