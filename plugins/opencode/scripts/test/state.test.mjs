import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";

import {
  listJobs,
  resolveJobFile,
  resolveJobsDir,
  resolveStateFile,
  upsertJob,
  writeJobFile
} from "../lib/state.mjs";
import { makeWorkspace } from "./helpers.mjs";

let ws;
beforeEach(() => {
  ws = makeWorkspace();
});
afterEach(() => {
  ws.cleanup();
});

test("upsertJob persists a job that listJobs reads back from per-job files", () => {
  upsertJob(ws.workspace, { id: "task-1", status: "queued", summary: "hello" });

  const jobs = listJobs(ws.workspace);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "task-1");
  assert.equal(jobs[0].status, "queued");

  // Per-job JSON files are the single authority; no shared state.json index.
  assert.equal(fs.existsSync(resolveStateFile(ws.workspace)), false);
  assert.equal(fs.existsSync(`${resolveJobsDir(ws.workspace)}/task-1.json`), true);
});

test("concurrent updates to different jobs do not overwrite each other", async () => {
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      Promise.resolve().then(() =>
        upsertJob(ws.workspace, { id: `job-${i}`, status: "running", n: i })
      )
    )
  );

  const jobs = listJobs(ws.workspace);
  const ids = new Set(jobs.map((job) => job.id));
  for (let i = 0; i < 20; i += 1) {
    assert.ok(ids.has(`job-${i}`), `job-${i} should survive concurrent writes`);
  }
});

test("upsertJob merges into an existing record without dropping prior fields", () => {
  upsertJob(ws.workspace, { id: "j1", status: "queued", model: "gpt", summary: "do it" });
  upsertJob(ws.workspace, { id: "j1", status: "running", pid: 42 });

  const [job] = listJobs(ws.workspace);
  assert.equal(job.status, "running");
  assert.equal(job.pid, 42);
  assert.equal(job.model, "gpt"); // preserved from the first write
  assert.equal(job.summary, "do it");
});

test("listJobs skips a corrupt/partially-written job file", () => {
  upsertJob(ws.workspace, { id: "good", status: "completed" });
  // Simulate an interrupted write leaving truncated JSON behind.
  writeJobFile(ws.workspace, "ignored", { id: "ignored" });
  fs.writeFileSync(resolveJobFile(ws.workspace, "broken"), "{ not valid json");

  const jobs = listJobs(ws.workspace);
  const ids = jobs.map((job) => job.id).sort();
  assert.deepEqual(ids, ["good", "ignored"]);
});
