import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { cancelJob, startBackgroundJob } from "../lib/job-runner.mjs";
import { readJobFile, readJobPromptFile, resolveJobFile, upsertJob } from "../lib/state.mjs";
import { makeWorkspace } from "./helpers.mjs";

let ws;
beforeEach(() => {
  ws = makeWorkspace();
});
afterEach(() => {
  ws.cleanup();
});

test("startBackgroundJob persists queued before spawn and never clobbers the watcher", () => {
  const baseRecord = { id: "task-bg", kind: "task", status: "queued", phase: "starting" };
  upsertJob(ws.workspace, baseRecord);

  let statusSeenBySpawn = null;
  const fakeSpawn = () => {
    // The watcher only starts once spawn is called: at that moment the parent
    // must already have persisted `queued`.
    statusSeenBySpawn = readJobFile(resolveJobFile(ws.workspace, "task-bg")).status;
    // Simulate the watcher immediately transitioning to running with its pid.
    upsertJob(ws.workspace, { id: "task-bg", status: "running", phase: "running", pid: 4321 });
    return { pid: 4321, unref() {} };
  };

  const started = startBackgroundJob({
    workspaceRoot: ws.workspace,
    baseRecord,
    prompt: "do the thing",
    options: {},
    selfPath: "/path/to/companion.mjs",
    spawn: fakeSpawn
  });

  assert.equal(statusSeenBySpawn, "queued");
  assert.equal(started.pid, 4321);

  // The parent must NOT have re-written the record after spawn.
  const persisted = readJobFile(resolveJobFile(ws.workspace, "task-bg"));
  assert.equal(persisted.status, "running");
  assert.equal(persisted.pid, 4321);

  // Prompt is handed to the watcher via a file.
  assert.equal(readJobPromptFile(ws.workspace, "task-bg"), "do the thing");
});

test("startBackgroundJob passes job id and prompt file to the watcher process", () => {
  const baseRecord = { id: "task-args", status: "queued" };
  upsertJob(ws.workspace, baseRecord);

  let spawnArgs = null;
  const fakeSpawn = (_execPath, args) => {
    spawnArgs = args;
    return { pid: 1, unref() {} };
  };

  startBackgroundJob({
    workspaceRoot: ws.workspace,
    baseRecord,
    prompt: "p",
    options: { model: "gpt-5" },
    selfPath: "/companion.mjs",
    spawn: fakeSpawn
  });

  assert.ok(spawnArgs.includes("_watch"));
  assert.ok(spawnArgs.includes("--job-id"));
  assert.ok(spawnArgs.includes("task-args"));
  assert.ok(spawnArgs.includes("--prompt-file"));
  assert.ok(spawnArgs.includes("--model"));
  assert.ok(spawnArgs.includes("gpt-5"));
});

test("cancelJob persists `canceled` when the signal is delivered", () => {
  upsertJob(ws.workspace, { id: "c1", status: "running", pid: 555 });
  const terminate = () => ({ attempted: true, delivered: true, method: "process-group" });

  const { job, outcome } = cancelJob({
    workspaceRoot: ws.workspace,
    job: { id: "c1", status: "running", pid: 555 },
    terminate
  });

  assert.equal(outcome.delivered, true);
  assert.equal(job.status, "canceled");
  assert.equal(readJobFile(resolveJobFile(ws.workspace, "c1")).status, "canceled");
});

test("cancelJob records `orphaned`, not `canceled`, when no signal was delivered", () => {
  upsertJob(ws.workspace, { id: "c2", status: "running", pid: 555 });
  // The process vanished between reconcile and signal — nothing was killed.
  const terminate = () => ({ attempted: true, delivered: false, method: "process-group" });

  const { job } = cancelJob({
    workspaceRoot: ws.workspace,
    job: { id: "c2", status: "running", pid: 555 },
    terminate
  });

  assert.equal(job.status, "orphaned");
  assert.equal(readJobFile(resolveJobFile(ws.workspace, "c2")).status, "orphaned");
});

test("runWatchedJob deletes the prompt file after reading it and completes", async () => {
  const { runWatchedJob } = await import("../lib/job-runner.mjs");
  upsertJob(ws.workspace, { id: "w1", status: "queued" });
  const { writeJobPromptFile, resolveJobPromptFile } = await import("../lib/state.mjs");
  const { existsSync } = await import("node:fs");
  writeJobPromptFile(ws.workspace, "w1", "run this");

  let promptSeen = null;
  const fakeRun = async (opts) => {
    promptSeen = opts.prompt;
    return { exitCode: 0, signal: null, durationMs: 5 };
  };

  const { job } = await runWatchedJob({
    workspaceRoot: ws.workspace,
    jobId: "w1",
    runForeground: fakeRun
  });

  assert.equal(promptSeen, "run this");
  assert.equal(job.status, "completed");
  assert.equal(existsSync(resolveJobPromptFile(ws.workspace, "w1")), false);
});

test("runWatchedJob fails gracefully when the prompt file is missing", async () => {
  const { runWatchedJob } = await import("../lib/job-runner.mjs");
  upsertJob(ws.workspace, { id: "w2", status: "queued" });

  let ran = false;
  const fakeRun = async () => {
    ran = true;
    return { exitCode: 0 };
  };

  const { job } = await runWatchedJob({
    workspaceRoot: ws.workspace,
    jobId: "w2",
    runForeground: fakeRun
  });

  assert.equal(ran, false); // never attempted to run without a prompt
  assert.equal(job.status, "failed");
  assert.match(job.errorMessage ?? "", /prompt/i);
});

test("runWatchedJob marks the job failed when opencode exits non-zero", async () => {
  const { runWatchedJob } = await import("../lib/job-runner.mjs");
  const { writeJobPromptFile } = await import("../lib/state.mjs");
  upsertJob(ws.workspace, { id: "w3", status: "queued" });
  writeJobPromptFile(ws.workspace, "w3", "p");

  const fakeRun = async () => ({ exitCode: 2, signal: null, durationMs: 1 });

  const { job } = await runWatchedJob({
    workspaceRoot: ws.workspace,
    jobId: "w3",
    runForeground: fakeRun
  });

  assert.equal(job.status, "failed");
  assert.equal(job.exitCode, 2);
});
