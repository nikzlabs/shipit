// Compile before consent; file only after consent, with the user's GitHub identity.

import type { AgentId } from "../../shared/types.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { redact, type ModelRunner } from "./redaction.js";

// Fixed upstream destination; never use the user's project repository.
export const UPSTREAM_REPO = { owner: "nikzlabs", repo: "shipit" } as const;

export type BugReportProducer = "session" | "ops";

export interface CompiledBugReport {
  cardId: string;
  title: string;
  body: string;
  stage2Ran: boolean;
  producer: BugReportProducer;
  buildId: string;
}

export function bugReportLabels(producer: BugReportProducer): string[] {
  return ["user-reported", producer === "ops" ? "source:ops" : "source:session"];
}

// The upstream Action reads this marker to label reports from users without push access.
function buildFooter(producer: BugReportProducer, buildId: string): string {
  const source = producer === "ops" ? "ops" : "session";
  return [
    "---",
    `Filed via ShipIt · build ${buildId} · source ${source}`,
    `<!-- shipit-report source=${source} build=${buildId} -->`,
  ].join("\n");
}

export async function compileBugReport(args: {
  cardId: string;
  title: string;
  body: string;
  producer: BugReportProducer;
  buildId: string | undefined;
  agentId?: AgentId;
  run?: ModelRunner;
}): Promise<CompiledBugReport> {
  const buildId = args.buildId?.trim() || "unknown";
  const redacted = await redact(args.body, {
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.run ? { run: args.run } : {}),
  });

  const body = `${redacted.body.trim()}\n\n${buildFooter(args.producer, buildId)}`;

  return {
    cardId: args.cardId,
    title: args.title.trim() || "ShipIt bug report",
    body,
    stage2Ran: redacted.stage2Ran,
    producer: args.producer,
    buildId,
  };
}

// Prefix the next user turn with outcomes; do not start a separate agent turn.
export function buildBugOutcomeNotice(
  outcomes: {
    title: string;
    phase: "filed" | "dismissed";
    issueNumber?: number | undefined;
    issueUrl?: string | undefined;
  }[],
): string {
  const lines = outcomes.map((o) => {
    // Flatten untrusted titles so they cannot add lines to the platform notice.
    const title = o.title.replace(/\s+/g, " ").trim().slice(0, 200);
    return o.phase === "filed"
      ? `- "${title}" — FILED as issue #${o.issueNumber} (${o.issueUrl}). Cite that number/URL if you reference the report later; never re-propose it.`
      : `- "${title}" — DECLINED by the user. Nothing was filed and nothing will be; do not re-propose it unless they ask.`;
  });
  if (lines.length === 0) return "";
  return [
    "[ShipIt] Since your last turn, the user resolved a bug-report card you proposed:",
    ...lines,
    "This is a status line from ShipIt, not part of the user's message. Those cards are resolved and block nothing — no acknowledgement is needed unless it changes what you were about to do.",
  ].join("\n");
}

export interface FileBugReportResult {
  success: boolean;
  url?: string;
  number?: number;
  message?: string;
  scopeError?: boolean;
}

export async function fileBugReport(
  githubAuthManager: GitHubAuthManager,
  args: { title: string; body: string; producer: BugReportProducer },
): Promise<FileBugReportResult> {
  const result = await githubAuthManager.createIssue({
    owner: UPSTREAM_REPO.owner,
    repo: UPSTREAM_REPO.repo,
    title: args.title.trim() || "ShipIt bug report",
    body: args.body,
    labels: bugReportLabels(args.producer),
  });

  return {
    success: result.success,
    ...(result.url ? { url: result.url } : {}),
    ...(typeof result.number === "number" ? { number: result.number } : {}),
    ...(result.message ? { message: result.message } : {}),
    ...(result.scopeError ? { scopeError: true } : {}),
  };
}
