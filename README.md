# opencode-plugin-cc

A Claude Code plugin that lets Claude (Opus) **delegate** bounded, mechanical coding tasks to [opencode](https://github.com/sst/opencode)'s secondary models (Kimi, Qwen, GLM, etc.).

Opus stays as the orchestrator / reviewer; opencode's cheaper model does the grunt work. All long-running output from opencode goes into a thin subagent's transcript, **not** into your main Opus context — so orchestration doesn't burn context.

This plugin is intentionally narrow: it only does delegation. Code review, planning, and reasoning stay with Opus.

> Mirrors the architecture of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), swapping the Codex CLI for the `opencode` CLI.

## What you get

- `/opencode:delegate <task>` — hand a task to opencode via the `opencode-delegate` subagent; blocks until done and returns the result (or a job-id when `--background`)
- `/opencode:status [job-id]` — list or inspect background jobs
- `/opencode:result <job-id>` — dump the stored output of a finished job
- `/opencode:cancel [job-id]` — kill an active background job
- `/opencode:setup` — verify opencode is installed and callable
- A subagent `opencode:opencode-delegate` — thin forwarder; Opus spawns it via the Agent tool

## Requirements

- **opencode ≥ 1.4.10** on `PATH`. Install via `brew install sst/tap/opencode` or `npm i -g opencode-ai`.
- **Node.js ≥ 18.18** (for the companion runtime).
- At least one opencode provider configured (`opencode auth login`).

## Install

```bash
/plugin marketplace add /Users/turygo/code/infra/opencode-plugin-cc
/plugin install opencode@opencode-plugin-cc
/reload-plugins
/opencode:setup
```

## Typical flow

```text
You:  /opencode:delegate --model moonshot/kimi-k2-turbo-preview give every exported function in src/auth/*.ts a JSDoc comment

Opus decides this is a delegable mechanical task and calls the `opencode-delegate` subagent.
The subagent runs `opencode run -m moonshot/kimi-k2-turbo-preview --prompt "..."` synchronously.
When opencode returns, Opus sees the final output (not the step-by-step tool log) and continues.
```

For long tasks you want to run unattended:

```text
/opencode:delegate --background port the validator test suite to vitest
# → [opencode-job] id=job-abc123 status=started pid=12345
# ... come back later ...
/opencode:status
/opencode:result job-abc123
```

## ⚠️ Security: default permissions

By default the companion passes `--dangerously-skip-permissions` to `opencode run`. Without this, opencode stalls on TUI permission prompts that no human will ever answer in a headless delegation. With it, opencode has **full write and shell-exec authority inside the current working directory**.

Always delegate **inside a git repository** and review the resulting diff before committing. If you want interactive permission prompts back, pass `--interactive`:

```text
/opencode:delegate --interactive write me a simple CLI
```

## Notes

- `--model <provider/model>` is passed through verbatim to `opencode run -m`. No aliases, no defaults — opencode's own config wins.
- `--continue` / `--session <id>` / `--agent <name>` are similarly pass-through.
- Default execution is foreground (`--wait`). Use `--background` when you want to detach.
- The plugin does **not** do code review — that's Opus's job. If you want a review-oriented Codex plugin, use [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) alongside this one.

## License

MIT
