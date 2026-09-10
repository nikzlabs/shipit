import fs from "node:fs";
import {
  sessionStateDirForWorkspace,
  sessionSharedStateDir,
  CI_LOGS_SUBDIR,
  CONTAINER_SESSION_STATE_DIR,
} from "../session-state-dir.js";
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
import { chownToSessionWorker, chownTreeToSessionWorker } from "../session-worker-uid.js";
import { prepareDispatch } from "../prepared-dispatch.js";

export async function fetchCIFailureLogs(
  githubAuth: GitHubAuthManager,
  owner: string,
  repo: string,
  failedChecks: { databaseId: number; name: string; conclusion: string; title: string }[],
  sessionDir?: string,
): Promise<CIFailureLog[]> {
  // Keep logs outside the repository, on the worker's state mount.
  const logDir = sessionDir
    ? path.join(sessionSharedStateDir(sessionStateDirForWorkspace(sessionDir)), CI_LOGS_SUBDIR)
    : null;
  if (logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    chownTreeToSessionWorker(logDir);
  }

  const logs: CIFailureLog[] = [];

  for (const check of failedChecks) {
    const [annotations, fullLog] = await Promise.all([
      githubAuth.getCheckRunAnnotations(owner, repo, check.databaseId),
      githubAuth.getJobLogs(owner, repo, check.databaseId),
    ]);

    const usefulAnnotations = annotations.filter(
      (a) => !(/^Process completed with exit code \d+\.?$/i.exec(a.message)),
    );

    const cleanLog = stripCILogBloat(fullLog);
    let logFilePath: string | undefined;
    if (logDir && cleanLog) {
      // Re-fetching the same run must reuse its path, so it does not look like a new failure.
      const safeName = check.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const fileName = `${safeName}-${check.databaseId}.log`;
      const absPath = path.join(logDir, fileName);
      fs.writeFileSync(absPath, cleanLog, "utf-8");
      chownToSessionWorker(absPath);
      logFilePath = `${CONTAINER_SESSION_STATE_DIR}/${CI_LOGS_SUBDIR}/${fileName}`;
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

function stripTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "");
}

const NOISE_PATTERNS: RegExp[] = [
  /^##\[(group|endgroup)\]/,
  /^##\[error\]Process completed with exit code/i,
  /^npm warn deprecated\b/,
  /^npm warn\b.*ERESOLVE/,
  /^\[command\]/,
  /^Post job cleanup\b/i,
  /^Cleaning up orphan processes$/,
  /^Temporarily overriding HOME=/,
  /^Adding repository directory to the temporary/,
  /^Commit: [0-9a-f]{40}\b/,
  /^Build Date:/,
  /^Worker ID:/,
  /^Runner Image:/,
  /^Runner Image Provision/,
  /^GITHUB_TOKEN Permissions/i,
  /^Current runner version:/,
  /^Prepare workflow directory$/,
  /^Getting action download info$/,
];

export function stripCILogBloat(log: string): string {
  const lines = log.split("\n");

  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Post job cleanup\b/i.test(stripTimestamp(lines[i]))) {
      end = i;
      break;
    }
  }

  const cleaned = lines.slice(0, end).filter((line) => {
    const bare = stripTimestamp(line);
    return !NOISE_PATTERNS.some((p) => p.test(bare));
  });

  return cleaned.join("\n").trimEnd();
}

const ERROR_PATTERNS: RegExp[] = [
  /\berror\b[\s:[]/i,
  /\bfailed\b/i,
  /\bfailure\b/i,
  /\b(?:FAIL|BROKEN)\b/,
  /^\s*✖|^\s*✗|^\s*×|^\s*❌/,
  /^\s*\d+ (?:error|failure|failed)/i,
  /:\d+:\d+/,
  /^E\s{3}/,
  /^\s*at\s+.*\(\S+:\d+:\d+\)/,
  /^\s*File ".*", line \d+/,
  /panicked at/,
  /^STDERR:/i,
];

export function extractErrorLines(cleanLog: string, maxLines = 30): string[] {
  const lines = cleanLog.split("\n");
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const bare = stripTimestamp(lines[i]);
    if (ERROR_PATTERNS.some((p) => p.test(bare))) {
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

  const urlMatch = /github\.com\/([^/]+)\/([^/]+)/.exec(prStatus.prUrl);
  if (!urlMatch) throw new ServiceError(400, "Cannot parse repository from PR URL");
  const [, owner, repo] = urlMatch;

  const runner = runnerRegistry.get(sessionId);
  if (!runner) throw new ServiceError(404, "No active session runner");

  const logs = await fetchCIFailureLogs(githubAuth, owner, repo, failedChecks, runner.sessionDir);
  const prompt = buildCIFixPrompt(logs);

  // A manual fix must not enter the automatic-fix state machine.
  // Refresh credentials before dispatch, as the WS path does.
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

  const queued = runner.running;
  runner.dispatch(prepareDispatch({
    text: prompt,
    agentInterface: undefined,
    activity: "Fixing CI…",
    execution: undefined,
    images: undefined,
    files: undefined,
    uploads: undefined,
    permissionMode: undefined,
    postTurn: undefined,
    systemTurn: undefined,
    onTurnComplete: undefined,
    deliveryId: undefined,
    dictated: undefined,
    resetMergedBranch: undefined,
    compactContext: undefined,
    silent: undefined,
  }));
  return { status: queued ? "queued" : "sent", attemptNumber: 1 };
}
