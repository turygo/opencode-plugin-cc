import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { nowIso } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "opencode-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

// Retained for callers/tests that need the legacy index path. Per-job JSON
// files are the single authority; this file is no longer written.
export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobStdoutFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.stdout`);
}

export function resolveJobStderrFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.stderr`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobPromptFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.prompt`);
}

// Write via a unique temp file + atomic rename so a reader never observes a
// half-written or truncated JSON record, even under concurrent writers.
function writeFileAtomic(filePath, contents) {
  const tempFile = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tempFile, contents, "utf8");
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    // Don't leave a partial temp file behind if the write or rename fails
    // (e.g. ENOSPC, EACCES).
    fs.rmSync(tempFile, { force: true });
    throw error;
  }
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function writeJobPromptFile(cwd, jobId, prompt) {
  ensureStateDir(cwd);
  const promptFile = resolveJobPromptFile(cwd, jobId);
  writeFileAtomic(promptFile, prompt);
  return promptFile;
}

export function readJobPromptFile(cwd, jobId) {
  return fs.readFileSync(resolveJobPromptFile(cwd, jobId), "utf8");
}

export function removeJobPromptFile(cwd, jobId) {
  fs.rmSync(resolveJobPromptFile(cwd, jobId), { force: true });
}

function safeReadJobFile(jobFile) {
  try {
    return readJobFile(jobFile);
  } catch {
    return null;
  }
}

function removeFileIfExists(filePath) {
  if (filePath) {
    fs.rmSync(filePath, { force: true });
  }
}

function removeJobArtifacts(cwd, job) {
  removeFileIfExists(resolveJobFile(cwd, job.id));
  removeFileIfExists(resolveJobPromptFile(cwd, job.id));
  removeFileIfExists(job.logFile ?? resolveJobLogFile(cwd, job.id));
  removeFileIfExists(job.stdoutFile ?? resolveJobStdoutFile(cwd, job.id));
  removeFileIfExists(job.stderrFile ?? resolveJobStderrFile(cwd, job.id));
}

// Read every per-job record from the jobs directory. Corrupt or partially
// written files are skipped rather than aborting the whole listing.
export function listJobs(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  let entries;
  try {
    entries = fs.readdirSync(jobsDir);
  } catch {
    return [];
  }

  const jobs = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const job = safeReadJobFile(path.join(jobsDir, entry));
    if (job && job.id) {
      jobs.push(job);
    }
  }
  return jobs;
}

function pruneJobs(cwd) {
  const jobs = listJobs(cwd);
  if (jobs.length <= MAX_JOBS) {
    return;
  }
  const ordered = [...jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
  for (const job of ordered.slice(MAX_JOBS)) {
    removeJobArtifacts(cwd, job);
  }
}

// Read-merge-write of a single job record. Because each job owns its own file
// and the parent stops writing once the watcher takes over, concurrent jobs
// never touch the same file and cannot clobber each other.
export function upsertJob(cwd, jobPatch) {
  ensureStateDir(cwd);
  const timestamp = nowIso();
  const existing = safeReadJobFile(resolveJobFile(cwd, jobPatch.id));
  const merged = existing
    ? { ...existing, ...jobPatch, updatedAt: timestamp }
    : { createdAt: timestamp, updatedAt: timestamp, ...jobPatch };
  writeJobFile(cwd, jobPatch.id, merged);
  pruneJobs(cwd);
  return merged;
}
