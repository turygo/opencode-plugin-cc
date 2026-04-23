import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

import { binaryAvailable, runCommand } from "./process.mjs";

const DEFAULT_BINARY = "opencode";

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

export function runOpencodeForeground(options, hooks = {}) {
  const binary = options.binary ?? DEFAULT_BINARY;
  const args = buildOpencodeArgs(options);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdoutBuf += text;
      hooks.onStdoutChunk?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrBuf += text;
      hooks.onStderrChunk?.(text);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        exitCode: code ?? (signal ? 128 : 0),
        signal,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        durationMs: Date.now() - started,
        command: binary,
        args
      });
    });
  });
}

export function spawnOpencodeDetached(options) {
  const binary = options.binary ?? DEFAULT_BINARY;
  const args = buildOpencodeArgs(options);

  const stdoutFd = fs.openSync(options.stdoutFile, "a");
  const stderrFd = fs.openSync(options.stderrFile, "a");

  const child = spawn(binary, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd]
  });
  child.unref();

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  return { pid: child.pid, command: binary, args };
}
