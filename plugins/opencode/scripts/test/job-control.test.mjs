import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  resolveCancelableJob,
  resolveResultJob
} from "../lib/job-control.mjs";
import { readJobFile, resolveJobFile, upsertJob } from "../lib/state.mjs";
import { makeWorkspace } from "./helpers.mjs";

let ws;
beforeEach(() => {
  ws = makeWorkspace();
});
afterEach(() => {
  ws.cleanup();
});

const dead = () => false;
const alive = () => true;

test("a running job whose process is gone is reconciled to orphaned and persisted", () => {
  upsertJob(ws.workspace, { id: "stale", status: "running", phase: "running", pid: 99999 });

  const { job } = buildSingleJobSnapshot(ws.workspace, "stale", { isAlive: dead });
  assert.equal(job.status, "orphaned");

  // Reconciliation persists so the next read is stable.
  assert.equal(readJobFile(resolveJobFile(ws.workspace, "stale")).status, "orphaned");
});

test("a running job with a live process is left running", () => {
  upsertJob(ws.workspace, { id: "live", status: "running", phase: "running", pid: 99999 });

  const { job } = buildSingleJobSnapshot(ws.workspace, "live", { isAlive: alive });
  assert.equal(job.status, "running");
});

test("buildStatusSnapshot moves a dead running job out of the active list", () => {
  upsertJob(ws.workspace, { id: "stale", status: "running", pid: 99999 });

  const snapshot = buildStatusSnapshot(ws.workspace, { isAlive: dead });
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.latestFinished?.id, "stale");
  assert.equal(snapshot.latestFinished?.status, "orphaned");
});

test("result for an orphaned job is retrievable (it is terminal)", () => {
  upsertJob(ws.workspace, { id: "stale", status: "running", pid: 99999 });

  const { job } = resolveResultJob(ws.workspace, "stale", { isAlive: dead });
  assert.equal(job.status, "orphaned");
});

test("cancel of a job whose process already exited reports orphaned, not canceled", () => {
  upsertJob(ws.workspace, { id: "stale", status: "running", pid: 99999 });

  assert.throws(
    () => resolveCancelableJob(ws.workspace, "stale", { isAlive: dead }),
    /no longer running|orphaned|already/i
  );
});
