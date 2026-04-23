---
description: Delegate a bounded, mechanical coding task to opencode (Kimi/Qwen/etc.) via the opencode-delegate subagent
argument-hint: "[--background|--wait] [--model <provider/model>] [--continue] [--session <id>] [--agent <name>] [--interactive] <task description>"
allowed-tools: Bash(node:*), Agent
---

Invoke the `opencode:opencode-delegate` subagent via the `Agent` tool (`subagent_type: "opencode:opencode-delegate"`), forwarding the raw user request as the prompt.

`opencode:opencode-delegate` is a subagent, not a skill — never call `Skill(opencode:opencode-delegate)` or `Skill(opencode:delegate)`. The command must run inline so the `Agent` tool stays in scope.

The final user-visible response must be the subagent's (i.e. opencode's) output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, instruct the subagent to use `--background`. Claude Code should still run the subagent in the foreground (so it reports the spawned `job-id` immediately), but the companion detaches opencode.
- If the request includes `--wait`, or neither flag is present, the subagent runs opencode synchronously (this is the default).
- `--background` and `--wait` are execution flags; they are stripped from the natural-language task text by the subagent, so the prompt opencode sees contains only the real task description.

If the user didn't supply any task text, ask what opencode should do — do not invoke the subagent with an empty prompt.

Operating rules:

- The subagent is a thin forwarder that makes one `Bash` call to `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task ...` and returns its stdout as-is.
- Return the companion stdout verbatim. Do not paraphrase, summarize, or add commentary.
- Do not ask the subagent to poll `/opencode:status`, fetch `/opencode:result`, or take follow-up action.
- If the subagent reports that opencode is missing or unauthenticated, stop and tell the user to run `/opencode:setup`.
