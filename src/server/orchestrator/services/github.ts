/**
 * GitHub services — reads (status, repos, search, PR status) and mutations
 * (PR create/merge, token, logout, quick PR creation).
 */

import fs from "node:fs";
import path from "node:path";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { CIFailureLog, PrAutoMergeError } from "../../shared/types/github-types.js";
import { extractFailedCheckRuns } from "../pr-status-poller.js";
import { parseGitHubRemote } from "../git-utils.js";
import { ServiceError } from "./types.js";
import { getErrorMessage } from "../validation.js";
import type { GitHubStatus } from "./types.js";

// ---- Read operations ----

/** Get GitHub authentication status. */
export function getGitHubStatus(githubAuthManager: GitHubAuthManager): GitHubStatus {
  return githubAuthManager.getStatus();
}

/** Get user's GitHub repos (empty array if not authenticated). */
export async function getGitHubRepos(
  githubAuthManager: GitHubAuthManager,
): Promise<Array<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }>> {
  if (!githubAuthManager.authenticated) return [];
  return githubAuthManager.listUserRepos();
}

/** Search GitHub repos. Returns user's repos when query is empty. */
export async function searchGitHubRepos(
  githubAuthManager: GitHubAuthManager,
  query: string,
) {
  if (!githubAuthManager.authenticated) return [];
  if (!query || query.length < 2) return githubAuthManager.listUserRepos();
  return githubAuthManager.searchRepos(query);
}

/** Get PR status for a session (returns null if no PR or not authenticated). */
export async function getPrStatus(
  githubAuthManager: GitHubAuthManager,
  git: GitManager,
) {
  if (!githubAuthManager.authenticated) return null;

  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) return null;

  const parsed = parseGitHubRemote(origin.url);
  if (!parsed) return null;

  const head = await git.getCurrentBranch();
  const pr = await githubAuthManager.findPullRequest(parsed.owner, parsed.repo, head);
  if (!pr) return null;

  const stats = await git.diffStatVsBranch(pr.base);
  const checks = await githubAuthManager.getCheckStatus(parsed.owner, parsed.repo, head);

  return {
    url: pr.url,
    number: pr.number,
    title: pr.title,
    baseBranch: pr.base,
    headBranch: head,
    insertions: stats.insertions,
    deletions: stats.deletions,
    checks,
    autoMergeEnabled: false,
    mergeable: true,
  };
}

// ---- Mutation operations ----

/** Create a pull request. */
export async function createPullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  title: string,
  body: string,
  base: string,
  draft?: boolean,
): Promise<{ success: boolean; url?: string; number?: number; message?: string }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const trimmedTitle = title.trim();
  const trimmedBase = base.trim();
  if (!trimmedTitle) throw new ServiceError(400, "PR title is required");
  if (trimmedTitle.length > 256) throw new ServiceError(400, "PR title too long (max 256 characters)");
  if (!trimmedBase) throw new ServiceError(400, "Base branch is required");

  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) throw new ServiceError(400, "No 'origin' remote configured");

  const parsed = parseGitHubRemote(origin.url);
  if (!parsed) throw new ServiceError(400, "Remote URL is not a GitHub repository");

  const head = await git.getCurrentBranch();
  const result = await githubAuthManager.createPullRequest({
    owner: parsed.owner,
    repo: parsed.repo,
    title: trimmedTitle,
    body: body.trim(),
    head,
    base: trimmedBase,
    draft,
  });
  return { success: result.success, url: result.url, number: result.number, message: result.message };
}

/** Merge a pull request. */
export async function mergePullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  method?: string,
): Promise<{ success: boolean; message: string; autoMergeEnabled?: boolean }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) return { success: false, message: "No origin remote configured" };

  const parsed = parseGitHubRemote(origin.url);
  if (!parsed) return { success: false, message: "Remote URL is not a GitHub repository" };

  const head = await git.getCurrentBranch();
  const pr = await githubAuthManager.findPullRequest(parsed.owner, parsed.repo, head);
  if (!pr) return { success: false, message: "No active PR for current branch" };

  const mergeMethod = (method || "merge") as "merge" | "squash" | "rebase";
  const result = await githubAuthManager.mergePullRequest(parsed.owner, parsed.repo, pr.number, mergeMethod);

  if (result.success) return { success: true, message: "Pull request merged" };

  // If merge failed because checks are pending, enable auto-merge
  const checks = await githubAuthManager.getCheckStatus(parsed.owner, parsed.repo, head);
  if (checks.state === "pending") {
    const graphqlMethod = mergeMethod === "merge" ? "MERGE" as const : mergeMethod === "squash" ? "SQUASH" as const : "REBASE" as const;
    const autoResult = await githubAuthManager.enableAutoMerge(parsed.owner, parsed.repo, pr.number, graphqlMethod);
    return { success: autoResult.success, message: autoResult.message, autoMergeEnabled: autoResult.success };
  }

  return { success: false, message: result.message };
}

/** Generate a PR description using the agent's generateText capability. */
export async function generatePrDescription(
  git: GitManager,
  generateText: (prompt: string, cwd?: string) => Promise<string>,
  sessionDir?: string,
): Promise<{ description: string }> {
  const log = await git.log(20);
  const diff = await git.diffSummary();

  if (log.length === 0) {
    return { description: "" };
  }

  const prompt = [
    "Write a pull request description summarizing these changes.",
    "Format as markdown with ## Summary (1-2 sentences) and ## Changes (bullet points).",
    "Keep it concise — 5-10 bullet points maximum.",
    "Return ONLY the markdown description, no extra commentary.",
    "",
    "Recent commits:",
    ...log.map((c) => `- ${c.message}`),
    "",
    "Files changed:",
    ...(diff.length > 0
      ? diff.map((f) => `- ${f.file} (+${f.insertions} -${f.deletions})`)
      : ["(no file-level diff available)"]),
  ].join("\n");

  const description = await generateText(prompt, sessionDir);
  return { description: description.trim() };
}

/** One-click PR creation — push, generate description, create PR. */
export async function quickCreatePr(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  chatHistoryManager: ChatHistoryManager,
  generateText: (prompt: string, cwd?: string) => Promise<string>,
  sessionId: string,
  sessionTitle: string,
  sessionDir?: string,
): Promise<{
  number: number;
  url: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  insertions: number;
  deletions: number;
}> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) throw new ServiceError(400, "No 'origin' remote configured");

  const parsed = parseGitHubRemote(origin.url);
  if (!parsed) throw new ServiceError(400, "Remote URL is not a GitHub repository");

  const head = await git.getCurrentBranch();

  // Check if there's already a PR for this branch
  const existingPr = await githubAuthManager.findPullRequest(parsed.owner, parsed.repo, head);
  if (existingPr) {
    const stats = await git.diffStatVsBranch(existingPr.base);
    return {
      number: existingPr.number,
      url: existingPr.url,
      title: existingPr.title,
      baseBranch: existingPr.base,
      headBranch: head,
      insertions: stats.insertions,
      deletions: stats.deletions,
    };
  }

  // Push the branch
  try {
    await git.push("origin", head);
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes("workflow")) {
      throw new ServiceError(403,
        "Your GitHub token is missing the `workflow` scope, which is required because this branch modifies GitHub Actions workflow files.\n" +
        "Please update your token at https://github.com/settings/tokens to include the `workflow` scope, then reconnect.");
    }
    throw new ServiceError(500, `Push failed: ${msg}`);
  }

  // Detect base branch (main or master)
  const remoteBranches = await git.listRemoteBranches();
  const baseBranch = remoteBranches.includes("main") ? "main" :
    remoteBranches.includes("master") ? "master" :
    remoteBranches[0] ?? "main";

  // Generate title from session title
  const title = sessionTitle || head;

  // Generate description from conversation context
  const description = await generatePrDescriptionFromContext(
    git, chatHistoryManager, generateText, sessionId, baseBranch, sessionDir,
  );

  // Create PR
  const result = await githubAuthManager.createPullRequest({
    owner: parsed.owner,
    repo: parsed.repo,
    title,
    body: description,
    head,
    base: baseBranch,
  });

  if (!result.success || !result.url || !result.number) {
    throw new ServiceError(500, result.message ?? "Failed to create pull request");
  }

  const stats = await git.diffStatVsBranch(baseBranch);

  return {
    number: result.number,
    url: result.url,
    title,
    baseBranch,
    headBranch: head,
    insertions: stats.insertions,
    deletions: stats.deletions,
  };
}

/** Generate a conversation-aware PR description. */
async function generatePrDescriptionFromContext(
  git: GitManager,
  chatHistoryManager: ChatHistoryManager,
  generateText: (prompt: string, cwd?: string) => Promise<string>,
  sessionId: string,
  baseBranch: string,
  sessionDir?: string,
): Promise<string> {
  try {
    const messages = chatHistoryManager.load(sessionId);
    const firstUserMsg = messages.find((m) => m.role === "user")?.text ?? "";

    // Build conversation excerpt (last N exchanges, ~2000 chars)
    const exchanges: string[] = [];
    let charCount = 0;
    for (let i = messages.length - 1; i >= 0 && charCount < 2000; i--) {
      const msg = messages[i];
      const prefix = msg.role === "user" ? "User" : "Assistant";
      const text = msg.text.slice(0, 500);
      exchanges.unshift(`${prefix}: ${text}`);
      charCount += text.length;
    }

    const log = await git.log(20);
    const diff = await git.diffSummary();

    // Get diff stat vs base branch
    let diffStatLine = "";
    try {
      const stats = await git.diffStatVsBranch(baseBranch);
      diffStatLine = `+${stats.insertions} -${stats.deletions}`;
    } catch { /* ignore */ }

    const prompt = [
      "Generate a pull request description for the following changes.",
      "",
      "## What the user asked for",
      `"${firstUserMsg.slice(0, 300)}"`,
      "",
      "## Key conversation exchanges",
      ...exchanges,
      "",
      "## Code changes",
      ...(diff.length > 0
        ? diff.map((f) => `- ${f.file} (+${f.insertions} -${f.deletions})`)
        : ["(no file-level diff available)"]),
      diffStatLine ? `Total: ${diffStatLine}` : "",
      "",
      "## Commit log",
      ...log.map((c) => `- ${c.message}`),
      "",
      "Write a concise GitHub PR description in markdown:",
      '1. A "## Summary" section (2-3 sentences explaining why)',
      '2. A "## Changes" section (bullet list of key changes)',
      '3. A "## Test plan" section (how to verify)',
      "Return ONLY the markdown description, no extra commentary.",
    ].join("\n");

    return await generateText(prompt, sessionDir);
  } catch (err) {
    console.warn("[pr] Failed to generate description:", err);
    // Fallback to basic description
    try {
      const log = await git.log(5);
      return [
        "## Summary",
        "Changes from ShipIt session.",
        "",
        "## Changes",
        ...log.map((c) => `- ${c.message}`),
      ].join("\n");
    } catch {
      return "Changes from ShipIt session.";
    }
  }
}

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
  failedChecks: Array<{ databaseId: number; name: string; conclusion: string; title: string }>,
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
      (a) => !a.message.match(/^Process completed with exit code \d+\.?$/i),
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
function stripCILogBloat(log: string): string {
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
function extractErrorLines(cleanLog: string, maxLines = 30): string[] {
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
): Promise<{ status: "sent" | "queued"; attemptNumber: number }> {
  if (!githubAuth.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const prStatus = prStatusPoller.getStatus(sessionId);
  if (!prStatus) throw new ServiceError(404, "No PR status found for this session");

  const prNode = prStatusPoller.getLastPrNode(sessionId);
  if (!prNode) throw new ServiceError(404, "No PR data cached for this session");

  const failedChecks = extractFailedCheckRuns(prNode);
  if (failedChecks.length === 0) throw new ServiceError(400, "No failed checks to fix");

  // Get repo info from the PR URL
  const urlMatch = prStatus.prUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
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

  // sendSystemMessage handles both cases: enqueues when busy,
  // emits system_turn event for WS handler pickup when idle.
  runner.sendSystemMessage(prompt);
  return { status: runner.running ? "queued" : "sent", attemptNumber };
}

// ---- Auto-merge operations ----

/** Toggle auto-merge on/off for a session's PR. */
export async function toggleAutoMerge(
  githubAuth: GitHubAuthManager,
  prStatusPoller: PrStatusPoller,
  sessionId: string,
  enabled: boolean,
): Promise<{ enabled: boolean; mergeMethod: "squash" | "merge" | "rebase" } | { error: PrAutoMergeError }> {
  if (!githubAuth.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const prStatus = prStatusPoller.getStatus(sessionId);
  if (!prStatus) throw new ServiceError(404, "No PR status found for this session");

  const urlMatch = prStatus.prUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!urlMatch) throw new ServiceError(400, "Cannot parse repository from PR URL");
  const [, owner, repo] = urlMatch;

  const autoMergeState = prStatusPoller.getAutoMergeState(sessionId);
  const mergeMethod = autoMergeState?.mergeMethod ?? "squash";

  if (enabled) {
    const graphqlMethod = mergeMethod === "merge" ? "MERGE" as const : mergeMethod === "squash" ? "SQUASH" as const : "REBASE" as const;
    const result = await githubAuth.enableAutoMerge(owner, repo, prStatus.prNumber, graphqlMethod);

    if (!result.success) {
      const settingsUrl = `https://github.com/${owner}/${repo}/settings`;
      const error: PrAutoMergeError = result.message.includes("auto-merge") || result.message.includes("auto merge")
        ? { code: "auto_merge_not_enabled", message: "Auto-merge is not enabled for this repository.", settingsUrl }
        : { code: "no_branch_protection", message: "Auto-merge requires branch protection rules.", settingsUrl: `${settingsUrl}/branches` };

      prStatusPoller.setAutoMergeEnabled(sessionId, false);
      prStatusPoller.setAutoMergeError(sessionId, error);
      return { error };
    }

    prStatusPoller.setAutoMergeEnabled(sessionId, true);
    return { enabled: true, mergeMethod };
  } else {
    await githubAuth.disableAutoMerge(owner, repo, prStatus.prNumber);
    prStatusPoller.setAutoMergeEnabled(sessionId, false);
    return { enabled: false, mergeMethod };
  }
}

/** Update the preferred merge method for a session. */
export async function updateMergeMethod(
  githubAuth: GitHubAuthManager,
  prStatusPoller: PrStatusPoller,
  sessionId: string,
  method: "squash" | "merge" | "rebase",
): Promise<{ mergeMethod: "squash" | "merge" | "rebase" }> {
  const autoMergeState = prStatusPoller.getAutoMergeState(sessionId);
  prStatusPoller.setMergeMethod(sessionId, method);

  // If auto-merge is active, re-enable with the new method
  if (autoMergeState?.enabled) {
    const prStatus = prStatusPoller.getStatus(sessionId);
    if (prStatus) {
      const urlMatch = prStatus.prUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (urlMatch) {
        const [, owner, repo] = urlMatch;
        await githubAuth.disableAutoMerge(owner, repo, prStatus.prNumber);
        const graphqlMethod = method === "merge" ? "MERGE" as const : method === "squash" ? "SQUASH" as const : "REBASE" as const;
        await githubAuth.enableAutoMerge(owner, repo, prStatus.prNumber, graphqlMethod);
      }
    }
  }

  return { mergeMethod: method };
}

/** Set GitHub token. Returns status and repos. */
export async function setGitHubToken(
  githubAuthManager: GitHubAuthManager,
  token: string,
): Promise<{
  status: GitHubStatus;
  repos: Array<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }>;
}> {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) throw new ServiceError(400, "GitHub token cannot be empty");
  const success = await githubAuthManager.setToken(trimmed);
  if (!success) throw new ServiceError(400, "Invalid GitHub token");
  const repos = await githubAuthManager.listUserRepos();
  return { status: githubAuthManager.getStatus(), repos };
}

/** Logout from GitHub. Returns updated status. */
export function gitHubLogout(
  githubAuthManager: GitHubAuthManager,
): { status: GitHubStatus } {
  githubAuthManager.clearCredentials();
  return { status: githubAuthManager.getStatus() };
}
