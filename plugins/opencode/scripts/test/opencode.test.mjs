import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createTailBuffer } from "../lib/fs.mjs";
import { runOpencodeForeground } from "../lib/opencode.mjs";

test("createTailBuffer keeps only the last maxLength characters", () => {
  const buffer = createTailBuffer(10);
  buffer.push("abcdef");
  buffer.push("ghijkl"); // total 12 chars pushed
  assert.equal(buffer.value().length, 10);
  assert.equal(buffer.value(), "cdefghijkl");
});

test("createTailBuffer returns everything when under the limit", () => {
  const buffer = createTailBuffer(100);
  buffer.push("hello ");
  buffer.push("world");
  assert.equal(buffer.value(), "hello world");
});

// A fake child process whose stdout/stderr we can drive synchronously.
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test("runOpencodeForeground bounds retained output but streams every chunk to hooks", async () => {
  const child = makeFakeChild();
  const fakeSpawn = () => child;

  let streamed = "";
  const promise = runOpencodeForeground(
    { binary: "opencode", prompt: "hi", spawn: fakeSpawn, tailBytes: 8 },
    { onStdoutChunk: (chunk) => (streamed += chunk) }
  );

  child.stdout.emit("data", Buffer.from("0123456789"));
  child.stdout.emit("data", Buffer.from("ABCDEF"));
  child.emit("close", 0, null);

  const result = await promise;

  // Hooks see the full stream...
  assert.equal(streamed, "0123456789ABCDEF");
  // ...but the retained tail is bounded.
  assert.equal(result.stdout.length, 8);
  assert.equal(result.stdout, "89ABCDEF");
  assert.equal(result.exitCode, 0);
});

test("checkOpencodeAuth reports ok when a stored credential exists", async () => {
  const { checkOpencodeAuth } = await import("../lib/opencode.mjs");
  const fakeOutput = [
    "┌  Credentials ~/.local/share/opencode/auth.json",
    "│",
    "●  Alibaba Coding Plan (China) api",
    "│",
    "└  1 credentials",
    "",
    "┌  Environment",
    "│",
    "●  xAI XAI_API_KEY",
    "│",
    "└  1 environment variables"
  ].join("\n");
  const runCommandImpl = () => ({ status: 0, stdout: fakeOutput, stderr: "", error: null });

  const auth = checkOpencodeAuth("opencode", { runCommandImpl });
  assert.equal(auth.ok, true);
  assert.equal(auth.credentials, 1);
  assert.equal(auth.envVars, 1);
});

test("checkOpencodeAuth is ok with only an environment API key (no stored credential)", async () => {
  const { checkOpencodeAuth } = await import("../lib/opencode.mjs");
  const fakeOutput = [
    "┌  Credentials ~/.local/share/opencode/auth.json",
    "└  0 credentials",
    "",
    "┌  Environment",
    "●  OpenAI OPENAI_API_KEY",
    "└  1 environment variables"
  ].join("\n");
  const runCommandImpl = () => ({ status: 0, stdout: fakeOutput, stderr: "", error: null });

  const auth = checkOpencodeAuth("opencode", { runCommandImpl });
  assert.equal(auth.ok, true);
  assert.equal(auth.credentials, 0);
  assert.equal(auth.envVars, 1);
});

test("checkOpencodeAuth is not ok with zero credentials and zero env keys", async () => {
  const { checkOpencodeAuth } = await import("../lib/opencode.mjs");
  const fakeOutput = [
    "┌  Credentials ~/.local/share/opencode/auth.json",
    "└  0 credentials",
    "",
    "┌  Environment",
    "└  0 environment variables"
  ].join("\n");
  const runCommandImpl = () => ({ status: 0, stdout: fakeOutput, stderr: "", error: null });

  const auth = checkOpencodeAuth("opencode", { runCommandImpl });
  assert.equal(auth.ok, false);
});
