#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { cancelJob, runWatchedJob, startBackgroundJob } from "./lib/job-runner.mjs";
import { readStdinIfPiped, safeReadFile, tailFile } from "./lib/fs.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob
} from "./lib/job-control.mjs";
import {
  checkOpencodeAuth,
  checkOpencodeBinary,
  checkOpencodeProviders,
  resolveOpencodeBinary,
  runOpencodeForeground
} from "./lib/opencode.mjs";
import {
  renderCancelReport,
  renderJobDetail,
  renderSetupReport,
  renderStatusSummary,
  renderStoredResult,
  renderTaskBackgroundStarted
} from "./lib/render.mjs";
import {
  generateJobId,
  resolveJobLogFile,
  resolveJobStderrFile,
  resolveJobStdoutFile,
  upsertJob
} from "./lib/state.mjs";
import { appendLogLine, createJobLogFile, nowIso, stampSession } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);

const TASK_FLAGS = {
  valueOptions: new Set(["model", "session", "agent", "dir"]),
  booleanOptions: new Set(["background", "wait", "continue"])
};

const WATCH_FLAGS = {
  valueOptions: new Set(["job-id", "workspace", "prompt-file", "model", "session", "agent", "dir"]),
  booleanOptions: new Set(["continue"])
};

const STATUS_FLAGS = {
  valueOptions: new Set(["timeout-ms"]),
  booleanOptions: new Set(["wait", "all", "json"])
};

const SETUP_FLAGS = {
  booleanOptions: new Set(["json"])
};

function normalizeArgv(rest) {
  if (rest.length === 1) {
    return splitRawArgumentString(rest[0]);
  }
  return rest;
}

function readPromptFromContext(positionals) {
  const stdin = readStdinIfPiped().trim();
  if (stdin) {
    return stdin;
  }
  return positionals.join(" ").trim();
}

async function handleTask(rest) {
  const argv = normalizeArgv(rest);
  const { options, positionals } = parseArgs(argv, TASK_FLAGS);
  const prompt = readPromptFromContext(positionals);
  if (!prompt) {
    process.stderr.write(
      "Error: no prompt provided. Pass the task text as positional args or via stdin.\n"
    );
    process.exit(2);
  }

  const binary = resolveOpencodeBinary();
  if (!binary) {
    process.stdout.write(
      "opencode CLI is not on PATH. Run /opencode:setup to install it.\n"
    );
    process.exit(1);
  }

  const cwd = process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const background = Boolean(options.background) && !options.wait;

  const jobId = generateJobId("task");
  const summary = prompt.slice(0, 200);
  const baseRecord = stampSession({
    id: jobId,
    kind: "task",
    status: background ? "queued" : "running",
    phase: background ? "starting" : "running",
    model: options.model ?? null,
    continueSession: Boolean(options.continue),
    session: options.session ?? null,
    agent: options.agent ?? null,
    dir: options.dir ?? null,
    summary,
    prompt: summary,
    logFile: resolveJobLogFile(workspaceRoot, jobId),
    stdoutFile: resolveJobStdoutFile(workspaceRoot, jobId),
    stderrFile: resolveJobStderrFile(workspaceRoot, jobId)
  });

  createJobLogFile(baseRecord.logFile, `opencode task ${jobId}`);
  appendLogLine(baseRecord.logFile, `model=${baseRecord.model ?? "default"}`);
  appendLogLine(baseRecord.logFile, `background=${background}`);
  upsertJob(workspaceRoot, baseRecord);

  if (background) {
    await runBackground({ workspaceRoot, baseRecord, options, prompt });
    return;
  }
  await runForeground({ workspaceRoot, baseRecord, options, prompt, binary });
}

async function runForeground({ workspaceRoot, baseRecord, options, prompt, binary }) {
  const startedAt = nowIso();
  const runningRecord = {
    ...baseRecord,
    status: "running",
    phase: "running",
    startedAt,
    pid: process.pid
  };
  upsertJob(workspaceRoot, runningRecord);

  let result;
  try {
    result = await runOpencodeForeground(
      {
        binary,
        cwd: options.dir ?? process.cwd(),
        prompt,
        model: options.model,
        continueSession: Boolean(options.continue),
        session: options.session,
        agent: options.agent,
        dir: options.dir,
        env: { ...process.env, NO_COLOR: process.env.NO_COLOR ?? "1" }
      },
      {
        onStdoutChunk: (chunk) => {
          process.stdout.write(chunk);
          fs.appendFileSync(baseRecord.stdoutFile, chunk);
        },
        onStderrChunk: (chunk) => {
          process.stderr.write(chunk);
          fs.appendFileSync(baseRecord.stderrFile, chunk);
        }
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failed = {
      ...runningRecord,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt: nowIso()
    };
    upsertJob(workspaceRoot, failed);
    process.stdout.write(
      `\n[opencode-job] id=${baseRecord.id} status=failed error=${errorMessage}\n`
    );
    process.exit(1);
  }

  const status = result.exitCode === 0 ? "completed" : "failed";
  const completed = {
    ...runningRecord,
    status,
    phase: status === "completed" ? "done" : "failed",
    pid: null,
    exitCode: result.exitCode,
    signal: result.signal ?? null,
    completedAt: nowIso(),
    durationMs: result.durationMs
  };
  upsertJob(workspaceRoot, completed);

  process.stdout.write(
    `\n[opencode-job] id=${baseRecord.id} status=${status} exit=${result.exitCode}${result.signal ? ` signal=${result.signal}` : ""} duration=${Math.round(result.durationMs / 100) / 10}s model=${baseRecord.model ?? "default"}\n`
  );

  if (status === "failed") {
    const stderrTail = result.stderr.trim().split(/\r?\n/).slice(-8).join("\n");
    if (stderrTail) {
      process.stdout.write(`stderr (tail):\n${stderrTail}\n`);
    }
    process.exit(result.exitCode || 1);
  }
}

async function runBackground({ workspaceRoot, baseRecord, options, prompt }) {
  const started = startBackgroundJob({
    workspaceRoot,
    baseRecord,
    prompt,
    options,
    selfPath: SELF_PATH
  });

  process.stdout.write(renderTaskBackgroundStarted(started));
}

async function handleWatch(rest) {
  const { options } = parseArgs(rest, WATCH_FLAGS);
  const jobId = options["job-id"];
  const workspaceRoot = options.workspace;
  const promptFile = options["prompt-file"];
  if (!jobId || !workspaceRoot || !promptFile) {
    process.stderr.write("Internal error: _watch missing required arguments\n");
    process.exit(2);
  }

  const { ok } = await runWatchedJob({ workspaceRoot, jobId, options });
  if (!ok) {
    process.exit(1);
  }
}

async function handleStatus(rest) {
  const argv = normalizeArgv(rest);
  const { options, positionals } = parseArgs(argv, STATUS_FLAGS);
  const jobRef = positionals[0];
  const cwd = process.cwd();

  if (!jobRef) {
    const snapshot = buildStatusSnapshot(cwd, {
      all: Boolean(options.all),
      env: process.env
    });
    process.stdout.write(renderStatusSummary(snapshot));
    return;
  }

  if (options.wait) {
    const timeoutMs = Number(options["timeout-ms"] ?? 240000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { workspaceRoot, job } = buildSingleJobSnapshot(cwd, jobRef);
      if (job.status !== "running" && job.status !== "queued") {
        printJobDetail(workspaceRoot, job);
        return;
      }
      if (Date.now() >= deadline) {
        process.stdout.write(
          `Timeout waiting for ${job.id}. Current status: ${job.status}.\n`
        );
        printJobDetail(workspaceRoot, job);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  const { workspaceRoot, job } = buildSingleJobSnapshot(cwd, jobRef);
  printJobDetail(workspaceRoot, job);
}

function printJobDetail(workspaceRoot, job) {
  const stdoutTail = tailFile(
    job.stdoutFile ?? resolveJobStdoutFile(workspaceRoot, job.id),
    4096
  );
  const stderrTail = tailFile(
    job.stderrFile ?? resolveJobStderrFile(workspaceRoot, job.id),
    2048
  );
  process.stdout.write(renderJobDetail(job, { stdoutTail, stderrTail }));
}

async function handleResult(rest) {
  const argv = normalizeArgv(rest);
  const { positionals } = parseArgs(argv, {});
  const jobRef = positionals[0];
  const cwd = process.cwd();

  const { workspaceRoot, job } = resolveResultJob(cwd, jobRef);
  const stored = readStoredJob(workspaceRoot, job.id) ?? job;
  const stdoutContent = safeReadFile(
    stored.stdoutFile ?? resolveJobStdoutFile(workspaceRoot, job.id)
  );
  const stderrContent = safeReadFile(
    stored.stderrFile ?? resolveJobStderrFile(workspaceRoot, job.id)
  );
  process.stdout.write(renderStoredResult(stored, stdoutContent, stderrContent));
}

async function handleCancel(rest) {
  const argv = normalizeArgv(rest);
  const { positionals } = parseArgs(argv, {});
  const jobRef = positionals[0];
  const cwd = process.cwd();

  const { workspaceRoot, job } = resolveCancelableJob(cwd, jobRef, { env: process.env });
  const { outcome } = cancelJob({ workspaceRoot, job, env: process.env });
  process.stdout.write(renderCancelReport(job, outcome));
}

async function handleSetup(rest) {
  const argv = normalizeArgv(rest);
  const { options } = parseArgs(argv, SETUP_FLAGS);
  const binaryPath = resolveOpencodeBinary();
  const binary = checkOpencodeBinary();
  const auth = binary.available
    ? checkOpencodeAuth()
    : { ok: false, credentials: 0, envVars: 0, detail: "skipped (opencode not installed)" };
  const providers = binary.available
    ? checkOpencodeProviders()
    : { ok: false, count: 0, detail: "skipped (opencode not installed)" };

  const nextSteps = [];
  if (!binary.available) {
    nextSteps.push(
      "Install opencode: `brew install sst/tap/opencode` or `npm install -g opencode-ai`."
    );
  } else if (!auth.ok) {
    nextSteps.push(
      "Authenticate a provider: run `!opencode auth login`, or export a provider API key (e.g. OPENAI_API_KEY)."
    );
  }

  // Readiness requires real credentials: `opencode models` lists free/built-in
  // models even with none configured, so it is reported but does not gate.
  const report = {
    ready: binary.available && auth.ok,
    binary: { path: binaryPath, version: binary.version, detail: binary.detail },
    auth,
    providers,
    nextSteps
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(renderSetupReport(report));
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand) {
    process.stderr.write(
      "Usage: opencode-companion.mjs <task|status|result|cancel|setup> [options]\n"
    );
    process.exit(2);
  }

  try {
    switch (subcommand) {
      case "task":
        return await handleTask(rest);
      case "_watch":
        return await handleWatch(rest);
      case "status":
        return await handleStatus(rest);
      case "result":
        return await handleResult(rest);
      case "cancel":
        return await handleCancel(rest);
      case "setup":
        return await handleSetup(rest);
      default:
        process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
        process.exit(2);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`opencode-companion error: ${message}\n`);
    process.exit(1);
  }
}

main();
