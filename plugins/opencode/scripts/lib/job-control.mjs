import fs from "node:fs";

import { listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { formatElapsedDuration, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;

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

function matchJobReference(jobs, reference, predicate = () => true) {
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

  throw new Error(`No job found for "${reference}". Run /opencode:status to list known jobs.`);
}

export function enrichJob(job) {
  const isActive = job.status === "queued" || job.status === "running";
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
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job));

  const latestFinishedRaw = jobs.find(
    (job) => job.status !== "queued" && job.status !== "running"
  ) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter(
      (job) =>
        job.status !== "queued" &&
        job.status !== "running" &&
        job.id !== latestFinished?.id
    )
    .map((job) => enrichJob(job));

  return {
    workspaceRoot,
    running,
    latestFinished,
    recent
  };
}

export function buildSingleJobSnapshot(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}".`);
  }
  return { workspaceRoot, job: enrichJob(selected) };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const allJobs = listJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(
    reference ? allJobs : filterJobsForCurrentSession(allJobs)
  );
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "canceled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "queued" || job.status === "running"
  );
  if (active) {
    throw new Error(
      `Job ${active.id} is still ${active.status}. Check /opencode:status and retry once it finishes.`
    );
  }

  if (reference) {
    throw new Error(
      `No finished job found for "${reference}". Run /opencode:status to inspect active jobs.`
    );
  }

  throw new Error("No finished opencode jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter(
    (job) => job.status === "queued" || job.status === "running"
  );

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
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
