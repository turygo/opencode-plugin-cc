import fs from "node:fs";

import { isProcessAlive } from "./process.mjs";
import { listJobs, readJobFile, resolveJobFile, writeJobFile } from "./state.mjs";
import { formatElapsedDuration, nowIso, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled", "orphaned"]);

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

// Reconcile persisted job state with real process state. A job that claims to
// be active but whose recorded process is gone (crashed watcher, killed
// machine) is transitioned to `orphaned` and persisted, so status/result/cancel
// never trust a stale `running` forever.
export function reconcileJobs(cwd, options = {}) {
  const isAlive = options.isAlive ?? ((pid) => isProcessAlive(pid));
  return listJobs(cwd).map((job) => {
    if (isActiveStatus(job.status) && Number.isFinite(job.pid) && !isAlive(job.pid)) {
      const timestamp = nowIso();
      const orphaned = {
        ...job,
        status: "orphaned",
        phase: "orphaned",
        pid: null,
        completedAt: job.completedAt ?? timestamp,
        updatedAt: timestamp
      };
      // Write the reconciled record directly. We already hold the full job, so
      // there is nothing to merge; going through upsertJob would re-read and
      // prune the whole jobs directory once per orphaned job — turning every
      // status/result/cancel read into M+1 full directory scans.
      writeJobFile(cwd, job.id, orphaned);
      return orphaned;
    }
    return job;
  });
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true, options = {}) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  if (options.allowEmpty) {
    return null;
  }
  throw new Error(`No job found for "${reference}". Run /opencode:status to list known jobs.`);
}

export function enrichJob(job) {
  const isActive = isActiveStatus(job.status);
  const isTerminal = !isActive;
  return {
    ...job,
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration: isTerminal
      ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
      : null
  };
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(
    filterJobsForCurrentSession(reconcileJobs(workspaceRoot, options), options)
  );
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;

  const running = jobs
    .filter((job) => isActiveStatus(job.status))
    .map((job) => enrichJob(job));

  const latestFinishedRaw = jobs.find((job) => !isActiveStatus(job.status)) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => !isActiveStatus(job.status) && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job));

  return {
    workspaceRoot,
    running,
    latestFinished,
    recent
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reconcileJobs(workspaceRoot, options));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}".`);
  }
  return { workspaceRoot, job: enrichJob(selected) };
}

export function resolveResultJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const allJobs = reconcileJobs(workspaceRoot, options);
  const jobs = sortJobsNewestFirst(
    reference ? allJobs : filterJobsForCurrentSession(allJobs, options)
  );

  // Resolve the reference against ALL jobs first, then branch on its state.
  // (Filtering by terminal status before resolution used to mask a still-running
  // job as "no job found".)
  const selected = matchJobReference(jobs, reference, () => true, { allowEmpty: !reference });

  if (selected) {
    if (isActiveStatus(selected.status)) {
      throw new Error(
        `Job ${selected.id} is still ${selected.status}. Check /opencode:status and retry once it finishes.`
      );
    }
    return { workspaceRoot, job: selected };
  }

  // No reference and nothing in this session: distinguish "active elsewhere"
  // from "nothing at all".
  const active = jobs.find((job) => isActiveStatus(job.status));
  if (active) {
    throw new Error(
      `Job ${active.id} is still ${active.status}. Check /opencode:status and retry once it finishes.`
    );
  }

  throw new Error("No finished opencode jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reconcileJobs(workspaceRoot, options));
  const activeJobs = jobs.filter((job) => isActiveStatus(job.status));

  if (reference) {
    const active = matchJobReference(activeJobs, reference, () => true, { allowEmpty: true });
    if (active) {
      return { workspaceRoot, job: active };
    }
    // The reference may still match a job that just finished/orphaned.
    const known = jobs.find(
      (job) => job.id === reference || job.id.startsWith(reference)
    );
    if (known && isTerminalStatus(known.status)) {
      throw new Error(`Job ${known.id} is no longer running (status: ${known.status}).`);
    }
    throw new Error(`No active job found for "${reference}".`);
  }

  const sessionScoped = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScoped.length === 1) {
    return { workspaceRoot, job: sessionScoped[0] };
  }
  if (sessionScoped.length > 1) {
    throw new Error("Multiple opencode jobs are active. Pass a job id to /opencode:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active opencode jobs to cancel for this session.");
  }

  throw new Error("No active opencode jobs to cancel.");
}
