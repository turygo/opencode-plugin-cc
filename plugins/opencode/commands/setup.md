---
description: Check whether the local opencode CLI is ready to use
argument-hint: ''
allowed-tools: Bash(node:*), Bash(brew:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup --json
```

If the result says opencode is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install opencode now.
- Put the `brew` option first if macOS homebrew is likely available; otherwise put `npm` first.
- Options:
  - `Install via Homebrew (Recommended on macOS)` → run `brew install sst/tap/opencode`
  - `Install via npm` → run `npm install -g opencode-ai`
  - `Skip for now`
- After install, rerun the setup check.

If opencode is installed but no provider is authenticated (no stored credential and no provider API key in the environment):
- Do not try to authenticate for the user. Tell them to run `!opencode auth login` themselves, or to export a provider key such as `OPENAI_API_KEY`.

Output rules:
- Present the final setup output to the user.
- Preserve the version string and the credentials detail. Readiness depends on credentials, not on the discoverable-model count (opencode lists free models even with no credentials).
