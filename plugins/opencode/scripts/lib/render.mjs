function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function truncate(text, maxLength = 80) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function renderTaskForegroundResult(job, result) {
  const status = result.exitCode === 0 ? "completed" : "failed";
  const lines = [];

  const stdout = result.stdout.trimEnd();
  if (stdout) {
    lines.push(stdout);
  } else if (status === "completed") {
    lines.push("(opencode completed with no stdout output)");
  } else {
    lines.push("(opencode failed with no stdout output)");
  }

  if (status === "failed" && result.stderr.trim()) {
    const tail = result.stderr.trim().split(/\r?\n/).slice(-12).join("\n");
    lines.push("", "stderr (last lines):", "```text", tail, "```");
  }

  lines.push(
    "",
    `[opencode-job] id=${job.id} status=${status} exit=${result.exitCode}${result.signal ? ` signal=${result.signal}` : ""} duration=${Math.round(result.durationMs / 100) / 10}s model=${job.model ?? "default"}`
  );

  return `${lines.join("\n")}\n`;
}

export function renderTaskBackgroundStarted(job) {
  const lines = [
    `[opencode-job] id=${job.id} status=started pid=${job.pid ?? "?"} model=${job.model ?? "default"}`,
    "",
    "opencode is running in the background. Check progress with:",
    `- /opencode:status ${job.id}`,
    `- /opencode:result ${job.id}   (after it finishes)`,
    `- /opencode:cancel ${job.id}   (to kill it)`
  ];
  return `${lines.join("\n")}\n`;
}

export function renderStatusSummary(snapshot) {
  const lines = ["# opencode status", ""];

  if (snapshot.running.length === 0 && !snapshot.latestFinished && snapshot.recent.length === 0) {
    lines.push("No opencode jobs recorded in this workspace yet.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("| Job | Status | Model | Phase | Elapsed | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");

  const allJobs = [...snapshot.running];
  if (snapshot.latestFinished) {
    allJobs.push(snapshot.latestFinished);
  }
  for (const job of snapshot.recent) {
    allJobs.push(job);
  }

  for (const job of allJobs) {
    const actions = [`/opencode:status ${job.id}`];
    if (job.status === "running" || job.status === "queued") {
      actions.push(`/opencode:cancel ${job.id}`);
    } else {
      actions.push(`/opencode:result ${job.id}`);
    }
    lines.push(
      "| " +
        [
          escapeMarkdownCell(job.id),
          escapeMarkdownCell(job.status ?? ""),
          escapeMarkdownCell(job.model ?? "default"),
          escapeMarkdownCell(job.phase ?? ""),
          escapeMarkdownCell(job.elapsed ?? job.duration ?? ""),
          escapeMarkdownCell(truncate(job.summary, 60)),
          actions.map((action) => `\`${action}\``).join("<br>")
        ].join(" | ") +
        " |"
    );
  }

  return `${lines.join("\n")}\n`;
}

export function renderJobDetail(job, extras = {}) {
  const lines = [
    "# opencode job",
    "",
    `- Id: ${job.id}`,
    `- Status: ${job.status}`,
    `- Phase: ${job.phase ?? "-"}`,
    `- Model: ${job.model ?? "default"}`,
    `- Created: ${job.createdAt ?? "-"}`
  ];

  if (job.startedAt) lines.push(`- Started: ${job.startedAt}`);
  if (job.completedAt) lines.push(`- Completed: ${job.completedAt}`);
  if (job.elapsed) lines.push(`- Elapsed: ${job.elapsed}`);
  if (job.duration) lines.push(`- Duration: ${job.duration}`);
  if (job.pid) lines.push(`- PID: ${job.pid}`);
  if (job.exitCode != null) lines.push(`- Exit code: ${job.exitCode}`);
  if (job.errorMessage) lines.push(`- Error: ${job.errorMessage}`);

  if (job.summary) {
    lines.push("", "## Prompt (truncated)", "", truncate(job.summary, 400));
  }

  if (extras.stdoutTail) {
    lines.push("", "## Recent stdout (tail)", "", "```text", extras.stdoutTail.trimEnd(), "```");
  }
  if (extras.stderrTail) {
    lines.push("", "## Recent stderr (tail)", "", "```text", extras.stderrTail.trimEnd(), "```");
  }

  if (job.status === "running" || job.status === "queued") {
    lines.push("", `Cancel: /opencode:cancel ${job.id}`);
  } else {
    lines.push("", `Full result: /opencode:result ${job.id}`);
  }

  return `${lines.join("\n")}\n`;
}

export function renderStoredResult(job, stdoutContent, stderrContent) {
  const lines = [
    `# opencode result (${job.id})`,
    "",
    `- Status: ${job.status}`,
    `- Model: ${job.model ?? "default"}`
  ];
  if (job.exitCode != null) lines.push(`- Exit code: ${job.exitCode}`);
  if (job.duration) lines.push(`- Duration: ${job.duration}`);
  if (job.durationMs != null && !job.duration) {
    lines.push(`- Duration: ${Math.round(job.durationMs / 100) / 10}s`);
  }
  if (job.errorMessage) lines.push(`- Error: ${job.errorMessage}`);

  if (job.summary) {
    lines.push("", "## Prompt (truncated)", "", truncate(job.summary, 400));
  }

  lines.push("", "## opencode stdout", "");
  if (stdoutContent?.trim()) {
    lines.push(stdoutContent.trimEnd());
  } else {
    lines.push("(empty)");
  }

  if (stderrContent?.trim() && (job.status === "failed" || job.status === "canceled")) {
    lines.push("", "## opencode stderr", "", "```text", stderrContent.trimEnd(), "```");
  }

  return `${lines.join("\n")}\n`;
}

export function renderCancelReport(job, outcome) {
  const lines = [
    "# opencode cancel",
    "",
    `- Job: ${job.id}`,
    `- Previous status: ${job.status}`,
    `- Signal delivered: ${outcome.delivered ? "yes" : "no"} (${outcome.method ?? "n/a"})`,
    "",
    "Run `/opencode:status` to confirm the updated state."
  ];
  return `${lines.join("\n")}\n`;
}

export function renderSetupReport(report) {
  const lines = [
    "# opencode setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- opencode binary: ${report.binary.path ? `${report.binary.path} (${report.binary.version ?? "unknown version"})` : "not found"}`,
    `- providers / models: ${report.providers.ok ? `${report.providers.count} available${report.providers.sample?.length ? ` — sample: ${report.providers.sample.slice(0, 3).join(", ")}` : ""}` : `unavailable — ${report.providers.detail}`}`
  ];

  if (report.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
