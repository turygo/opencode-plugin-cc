import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

import { runOpencodeForeground } from "./opencode.mjs";
import { terminateProcessTree } from "./process.mjs";
import {
  readJobFile,
  readJobPromptFile,
  removeJobPromptFile,
  resolveJobFile,
  resolveJobStderrFile,
  resolveJobStdoutFile,
  upsertJob,
  writeJobPromptFile
} from "./state.mjs";
import { nowIso } from "./tracked-jobs.mjs";

export function buildWatchArgs({ selfPath, jobId, workspaceRoot, promptFile, options = {} }) {
  const args = [
    selfPath,
    "_watch",
    "--job-id",
    jobId,
    "--workspace",
    workspaceRoot,
    "--prompt-file",
    promptFile
  ];
  if (options.model) args.push("--model", options.model);
  if (options.session) args.push("--session", options.session);
  if (options.agent) args.push("--agent", options.agent);
  if (options.dir) args.push("--dir", options.dir);
  if (options.continue) args.push("--continue");
  return args;
}

// Spawn the detached watcher for a background job.
//
// Ordering matters: the `queued` record is persisted BEFORE the watcher is
// spawned, and the parent never writes the record again afterwards. The watcher
// owns every transition from `running` onward (recording its own pid), so there
// is no window in which the parent can overwrite the watcher's progress.
export function startBackgroundJob({
  workspaceRoot,
  baseRecord,
  prompt,
  options = {},
  selfPath,
  spawn = nodeSpawn,
  execPath = process.execPath,
  cwd = options.dir ?? process.cwd(),
  env = process.env
}) {
  const promptFile = writeJobPromptFile(workspaceRoot, baseRecord.id, prompt);

  // Persist `queued` (idempotent with the caller's initial write) so the
  // watcher is guaranteed to find its record the instant it starts.
  upsertJob(workspaceRoot, {
    id: baseRecord.id,
    status: "queued",
    phase: "starting"
  });

  const args = buildWatchArgs({
    selfPath,
    jobId: baseRecord.id,
    workspaceRoot,
    promptFile,
    options
  });

  const child = spawn(execPath, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env
  });
  child.unref?.();

  // Returned for rendering only — deliberately NOT persisted.
  return { ...baseRecord, promptFile, pid: child.pid };
}

function safeReadStoredJob(workspaceRoot, jobId) {
  try {
    return readJobFile(resolveJobFile(workspaceRoot, jobId));
  } catch {
    return null;
  }
}

// Drive a single background job inside the detached watcher process. Owns every
// transition once spawned: reads (and immediately deletes) the prompt file,
// records `running` with its own pid, runs opencode streaming output to files,
// then records the terminal state. The prompt is removed right after a
// successful read so it never lingers; a missing prompt fails the job cleanly
// instead of crashing the watcher.
export async function runWatchedJob({
  workspaceRoot,
  jobId,
  options = {},
  env = { ...process.env, NO_COLOR: process.env.NO_COLOR ?? "1" },
  runForeground = runOpencodeForeground,
  readPrompt = readJobPromptFile,
  removePrompt = removeJobPromptFile
}) {
  const stored = safeReadStoredJob(workspaceRoot, jobId) ?? { id: jobId };

  let prompt;
  try {
    prompt = readPrompt(workspaceRoot, jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = upsertJob(workspaceRoot, {
      id: jobId,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage: `prompt file unreadable: ${message}`,
      completedAt: nowIso()
    });
    return { job: failed, ok: false };
  }
  removePrompt(workspaceRoot, jobId);

  upsertJob(workspaceRoot, {
    id: jobId,
    status: "running",
    phase: "running",
    pid: process.pid,
    startedAt: nowIso()
  });

  const stdoutFile = stored.stdoutFile ?? resolveJobStdoutFile(workspaceRoot, jobId);
  const stderrFile = stored.stderrFile ?? resolveJobStderrFile(workspaceRoot, jobId);

  try {
    const result = await runForeground(
      {
        cwd: options.dir ?? stored.dir ?? process.cwd(),
        prompt,
        model: options.model ?? stored.model ?? null,
        continueSession: Boolean(options.continue),
        session: options.session ?? stored.session ?? null,
        agent: options.agent ?? stored.agent ?? null,
        dir: options.dir ?? stored.dir ?? null,
        env
      },
      {
        onStdoutChunk: (chunk) => fs.appendFileSync(stdoutFile, chunk),
        onStderrChunk: (chunk) => fs.appendFileSync(stderrFile, chunk)
      }
    );

    const status = result.exitCode === 0 ? "completed" : "failed";
    const job = upsertJob(workspaceRoot, {
      id: jobId,
      status,
      phase: status === "completed" ? "done" : "failed",
      pid: null,
      exitCode: result.exitCode,
      signal: result.signal ?? null,
      completedAt: nowIso(),
      durationMs: result.durationMs
    });
    return { job, ok: status === "completed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = upsertJob(workspaceRoot, {
      id: jobId,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage: message,
      completedAt: nowIso()
    });
    return { job: failed, ok: false };
  }
}

// Signal a job's process tree and record the honest outcome. If the signal was
// actually delivered the job is `canceled`; if the process was already gone
// (delivered=false) it is `orphaned` instead — we never claim a cancellation we
// did not perform.
export function cancelJob({ workspaceRoot, job, terminate = terminateProcessTree, env }) {
  const outcome = terminate(job.pid, { env });
  const status = outcome.delivered ? "canceled" : "orphaned";
  const updated = upsertJob(workspaceRoot, {
    id: job.id,
    status,
    phase: status,
    pid: null,
    completedAt: nowIso()
  });
  return { job: updated, outcome };
}
