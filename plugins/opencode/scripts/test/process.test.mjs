import assert from "node:assert/strict";
import { test } from "node:test";

import { isProcessAlive, terminateProcessTree } from "../lib/process.mjs";

test("isProcessAlive reports false for a non-finite pid", () => {
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive(undefined), false);
  assert.equal(isProcessAlive(Number.NaN), false);
});

test("isProcessAlive treats a successful signal-0 as alive", () => {
  const killImpl = () => true; // no throw == process exists
  assert.equal(isProcessAlive(1234, { killImpl }), true);
});

test("isProcessAlive treats ESRCH as not alive", () => {
  const killImpl = () => {
    const error = new Error("no such process");
    error.code = "ESRCH";
    throw error;
  };
  assert.equal(isProcessAlive(1234, { killImpl }), false);
});

test("isProcessAlive treats EPERM as alive (exists but not ours to signal)", () => {
  const killImpl = () => {
    const error = new Error("operation not permitted");
    error.code = "EPERM";
    throw error;
  };
  assert.equal(isProcessAlive(1234, { killImpl }), true);
});

test("terminateProcessTree reports not delivered when the process is already gone", () => {
  const killImpl = () => {
    const error = new Error("no such process");
    error.code = "ESRCH";
    throw error;
  };
  const outcome = terminateProcessTree(4321, { platform: "linux", killImpl });
  assert.equal(outcome.delivered, false);
});
