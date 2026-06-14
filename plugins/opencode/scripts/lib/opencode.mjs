import { spawn as nodeSpawn } from "node:child_process";
import process from "node:process";

import { createTailBuffer } from "./fs.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";

const DEFAULT_BINARY = "opencode";
const DEFAULT_TAIL_BYTES = 65536;

export function resolveOpencodeBinary(binary = DEFAULT_BINARY) {
  const which = runCommand(process.platform === "win32" ? "where" : "which", [binary]);
  if (which.status !== 0) {
    return null;
  }
  const first = which.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first || null;
}

export function checkOpencodeBinary(binary = DEFAULT_BINARY) {
  const result = binaryAvailable(binary, ["--version"]);
  return {
    available: result.available,
    version: result.available ? result.detail : null,
    detail: result.detail
  };
}

export function checkOpencodeProviders(binary = DEFAULT_BINARY) {
  const result = runCommand(binary, ["models"]);
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      count: 0,
      detail: (result.stderr || result.stdout || "").trim() || `exit ${result.status}`
    };
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    ok: lines.length > 0,
    count: lines.length,
    sample: lines.slice(0, 5),
    detail: lines.length ? `${lines.length} model(s) available` : "no models listed"
  };
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;]*m/g;

function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, "");
}

// Discover whether opencode has usable credentials. `opencode models` lists
// built-in/free models even with zero credentials, so it cannot prove a task
// will run. `opencode auth list` reports both stored credentials and provider
// environment keys; either is enough to authenticate a request.
//
// The CLI output is formatted for humans, so this parses defensively: it counts
// the summary lines ("N credentials" / "N environment variables") rather than
// the decorative per-entry rows.
export function checkOpencodeAuth(binary = DEFAULT_BINARY, options = {}) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const result = runCommandImpl(binary, ["auth", "list"]);
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      credentials: 0,
      envVars: 0,
      detail: (result.stderr || result.stdout || "").trim() || `exit ${result.status}`
    };
  }

  const text = stripAnsi(result.stdout || "");
  const credentials = matchCount(text, /(\d+)\s+credentials?\b/i);
  const envVars = matchCount(text, /(\d+)\s+environment variables?\b/i);
  const ok = credentials > 0 || envVars > 0;
  return {
    ok,
    credentials,
    envVars,
    detail: ok
      ? `${credentials} credential(s), ${envVars} environment key(s)`
      : "no credentials or provider environment keys found"
  };
}

function matchCount(text, pattern) {
  const match = text.match(pattern);
  return match ? Number(match[1]) : 0;
}

export function buildOpencodeArgs(options = {}) {
  const args = ["run", "--dangerously-skip-permissions"];
  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.continueSession) {
    args.push("-c");
  }
  if (options.session) {
    args.push("-s", options.session);
  }
  if (options.agent) {
    args.push("--agent", options.agent);
  }
  if (options.dir) {
    args.push("--dir", options.dir);
  }
  if (options.format) {
    args.push("--format", options.format);
  }
  if (options.prompt) {
    args.push(options.prompt);
  }
  return args;
}

// Runs `opencode run ...`, streaming every chunk to the hooks (which persist
// full output to files) while retaining only a bounded tail in memory. A long
// background task therefore cannot grow the watcher's memory without limit; the
// returned stdout/stderr are the last `tailBytes` characters, used only for
// inline error display.
export function runOpencodeForeground(options, hooks = {}) {
  const binary = options.binary ?? DEFAULT_BINARY;
  const spawn = options.spawn ?? nodeSpawn;
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
  const args = buildOpencodeArgs(options);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stdoutTail = createTailBuffer(tailBytes);
    const stderrTail = createTailBuffer(tailBytes);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdoutTail.push(text);
      hooks.onStdoutChunk?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrTail.push(text);
      hooks.onStderrChunk?.(text);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        exitCode: code ?? (signal ? 128 : 0),
        signal,
        stdout: stdoutTail.value(),
        stderr: stderrTail.value(),
        durationMs: Date.now() - started,
        command: binary,
        args
      });
    });
  });
}
