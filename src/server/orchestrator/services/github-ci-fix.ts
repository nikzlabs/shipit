/**
 * CI-fix logic — fetch failure logs, strip noise, extract errors, build prompts,
 * and trigger auto-fix via Claude.
 *
 * Extracted from github.ts for single-responsibility.
 */

import fs from "node:fs";
import path from "node:path";
import type { GitHubAuthManager } from "../github-auth.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionManager } from "../sessions.js";
import type { CredentialStore } from "../credential-store.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { CIFailureLog } from "../../shared/types/github-types.js";
import { extractFailedCheckRuns } from "../pr-status-poller.js";
import { prepareSessionAgentEnvironment } from "../session-agent-env.js";
import { ServiceError } from "./types.js";

// ---- CI fix operations ----

/**
 * Fetch CI failure logs for each failed check run.
 * Full logs are written to .shipit/ci-logs/ in the session directory;
 * the returned CIFailureLog contains only the last 30 lines as a snippet.
 */
export async function fetchCIFailureLogs(
  githubAuth: GitHubAuthManager,
  owner: string,
  repo: string,
  failedChecks: { databaseId: number; name: string; conclusion: string; title: string }[],
  sessionDir?: string,
): Promise<CIFailureLog[]> {
  // Prepare log directory and ensure .shipit is gitignored
  const logDir = sessionDir ? path.join(sessionDir, ".shipit", "ci-logs") : null;
  if (logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    ensureShipitGitignored(sessionDir!);
  }

  const logs: CIFailureLog[] = [];

  for (const check of failedChecks) {
    // Fetch both annotations and raw logs in parallel.
    const [annotations, fullLog] = await Promise.all([
      githubAuth.getCheckRunAnnotations(owner, repo, check.databaseId),
      githubAuth.getJobLogs(owner, repo, check.databaseId),
    ]);

    // Filter out unhelpful annotations that just say "process completed"
    const usefulAnnotations = annotations.filter(
      (a) => !(/^Process completed with exit code \d+\.?$/i.exec(a.message)),
    );

    // Strip GitHub Actions noise, extract errors, write to disk
    const cleanLog = stripCILogBloat(fullLog);
    let logFilePath: string | undefined;
    if (logDir && cleanLog) {
      const safeName = check.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const absPath = path.join(logDir, `${safeName}.log`);
      fs.writeFileSync(absPath, cleanLog, "utf-8");
      // Store relative path — the agent runs from the workspace root
      logFilePath = `.shipit/ci-logs/${safeName}.log`;
    }
    const errorLines = extractErrorLines(cleanLog);
    const lines = cleanLog.split("\n");
    const logExcerpt = lines.slice(-20).join("\n");

    logs.push({
      checkName: check.name,
      conclusion: check.conclusion,
      summary: check.title,
      annotations: usefulAnnotations,
      errorLines,
      logExcerpt,
      logFilePath,
    });
  }

  return logs;
}

/** Strip timestamp prefix from a GitHub Actions log line. */
function stripTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "");
}

/** Noise patterns to remove from CI logs entirely. */
const NOISE_PATTERNS: RegExp[] = [
  /^##\[(group|endgroup)\]/,                        // GHA grouping markers
  /^##\[error\]Process completed with exit code/i,  // generic exit code error
  /^npm warn deprecated\b/,                         // npm deprecation warnings
  /^npm warn\b.*ERESOLVE/,                          // npm peer dep warnings
  /^\[command\]/,                                    // GHA [command] lines
  /^Post job cleanup\b/i,                           // post-job header
  /^Cleaning up orphan processes$/,                 // post-job trailer
  /^Temporarily overriding HOME=/,                  // GHA git HOME override
  /^Adding repository directory to the temporary/,  // GHA safe.directory
  /^Commit: [0-9a-f]{40}\b/,                        // GHA runner commit hash
  /^Build Date:/,                                    // GHA runner build date
  /^Worker ID:/,                                     // GHA runner worker ID
  /^Runner Image:/,                                  // GHA runner image info
  /^Runner Image Provision/,                         // GHA runner provisioner
  /^GITHUB_TOKEN Permissions/i,                      // GHA token permissions header
  /^Current runner version:/,                        // GHA runner version
  /^Prepare workflow directory$/,                    // GHA setup step
  /^Getting action download info$/,                 // GHA action download
];

/**
 * Strip GitHub Actions noise from log output: post-job cleanup, deprecation
 * warnings, grouping markers, and other lines with no diagnostic value.
 */
export function stripCILogBloat(log: string): string {
  const lines = log.split("\n");

  // Trim everything after the last "Post job cleanup." line
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Post job cleanup\b/i.test(stripTimestamp(lines[i]))) {
      end = i;
      break;
    }
  }

  // Filter remaining lines through noise patterns
  const cleaned = lines.slice(0, end).filter((line) => {
    const bare = stripTimestamp(line);
    return !NOISE_PATTERNS.some((p) => p.test(bare));
  });

  return cleaned.join("\n").trimEnd();
}

/** Error-like patterns that indicate actual failure output. */
const ERROR_PATTERNS: RegExp[] = [
  /\berror\b[\s:[]/i,                     // "error:", "error [", "Error:"
  /\bfailed\b/i,                           // "failed", "FAILED"
  /\bfailure\b/i,                          // "failure"
  /\b(?:FAIL|BROKEN)\b/,                   // test runners: "FAIL", "BROKEN"
  /^\s*✖|^\s*✗|^\s*×|^\s*❌/,              // unicode error markers
  /^\s*\d+ (?:error|failure|failed)/i,     // "1 error", "3 failures"
  /:\d+:\d+/,                              // file:line:col (compiler/linter output)
  /^E\s{3}/,                               // pytest "E   " assertion lines
  /^\s*at\s+.*\(\S+:\d+:\d+\)/,           // JS stack traces
  /^\s*File ".*", line \d+/,              // Python tracebacks
  /panicked at/,                           // Rust panics
  /^STDERR:/i,                             // explicit stderr markers
];

/**
 * Extract lines that look like actual errors from a cleaned CI log.
 * Returns a deduplicated, ordered subset of the most actionable lines.
 */
export function extractErrorLines(cleanLog: string, maxLines = 30): string[] {
  const lines = cleanLog.split("\n");
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const bare = stripTimestamp(lines[i]);
    if (ERROR_PATTERNS.some((p) => p.test(bare))) {
      // Include 1 line of context before and after the error line
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      for (let j = start; j < end; j++) {
        const clean = stripTimestamp(lines[j]);
        if (clean && !errors.includes(clean)) errors.push(clean);
      }
    }
  }

  return errors.slice(0, maxLines);
}

/** Ensure .shipit is listed in .gitignore so CI logs don't get committed. */
function ensureShipitGitignored(dir: string): void {
  const gitignorePath = path.join(dir, ".gitignore");
  try {
    const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf-8") : "";
    if (!content.split("\n").some((line) => line.trim() === ".shipit")) {
      fs.appendFileSync(gitignorePath, `${content.endsWith("\n") ? "" : "\n"}.shipit\n`);
    }
  } catch {
    // Best-effort — don't fail CI fix if gitignore can't be written
  }
}

/** Build a fix prompt from CI failure logs. */
export function buildCIFixPrompt(logs: CIFailureLog[]): string {
  const sections = logs.map((log) => {
    const parts: string[] = [`## ${log.checkName}`];
    if (log.summary && !/^(failure|success|cancelled|timed.out|skipped)$/i.test(log.summary)) {
      parts.push(log.summary);
    }

    if (log.annotations.length > 0) {
      parts.push("");
      for (const a of log.annotations) {
        parts.push(`- ${a.path}:${a.startLine} — ${a.message}`);
      }
    }

    if (log.errorLines.length > 0) {
      parts.push("", "```", ...log.errorLines, "```");
    } else if (log.logExcerpt) {
      parts.push("", "```", log.logExcerpt, "```");
    }

    if (log.logFilePath) {
      parts.push(`Full log: \`${log.logFilePath}\``);
    }

    return parts.join("\n");
  });

  return [
    "[ci-fix] CI failed. Fix these errors:",
    "",
    ...sections,
    "",
    "Read the full log files if the errors above are unclear.",
  ].join("\n");
}

/**
 * Trigger a CI fix — fetch logs, build prompt, send to Claude.
 * Returns whether the message was sent immediately or queued.
 */
export async function triggerCIFix(
  githubAuth: GitHubAuthManager,
  prStatusPoller: PrStatusPoller,
  runnerRegistry: SessionRunnerRegistry,
  sessionId: string,
  sessionManager: SessionManager,
  credentialsDir: string | undefined,
  credentialStore: CredentialStore | undefined,
  providerAccountManager?: ProviderAccountManager,
): Promise<{ status: "sent" | "queued"; attemptNumber: number }> {
  if (!githubAuth.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const prStatus = prStatusPoller.getStatus(sessionId);
  if (!prStatus) throw new ServiceError(404, "No PR status found for this session");

  const prNode = prStatusPoller.getLastPrNode(sessionId);
  if (!prNode) throw new ServiceError(404, "No PR data cached for this session");

  const failedChecks = extractFailedCheckRuns(prNode);
  if (failedChecks.length === 0) throw new ServiceError(400, "No failed checks to fix");

  // Get repo info from the PR URL
  const urlMatch = /github\.com\/([^/]+)\/([^/]+)/.exec(prStatus.prUrl);
  if (!urlMatch) throw new ServiceError(400, "Cannot parse repository from PR URL");
  const [, owner, repo] = urlMatch;

  // Send to Claude via the runner
  const runner = runnerRegistry.get(sessionId);
  if (!runner) throw new ServiceError(404, "No active session runner");

  // Fetch CI failure logs — write full logs to .shipit/ci-logs/ in the session dir
  const logs = await fetchCIFailureLogs(githubAuth, owner, repo, failedChecks, runner.sessionDir);
  const prompt = buildCIFixPrompt(logs);

  // Update auto-fix state
  prStatusPoller.markAutoFixRunning(sessionId);
  const autoFixState = prStatusPoller.getAutoFixState(sessionId);
  const attemptNumber = autoFixState?.attemptCount ?? 1;

  // docs/149 — bring the session's env up to date (OAuth token sync,
  // MCP refresh, secrets push) before the system turn fires. Without
  // this, the CI-fix turn used to inherit none of the WS path's env
  // discipline, so a rotated OAuth token here also produces a 401.
  if (credentialsDir && credentialStore) {
    await prepareSessionAgentEnvironment(runner, {
      sessionId,
      agentId: runner.agentId,
      deps: {
        credentialsDir,
        credentialStore,
        sessionManager,
        ...(providerAccountManager ? { providerAccountManager } : {}),
      },
    });
  }

  // dispatch handles both cases: enqueues when busy, emits system_turn
  // event for WS handler pickup when idle.
  runner.dispatch({ text: prompt, activity: "Auto-fixing CI..." });
  return { status: runner.running ? "queued" : "sent", attemptNumber };
}
