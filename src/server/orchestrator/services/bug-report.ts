/**
 * bug-report.ts — user bug filing against ShipIt itself (docs/164).
 *
 * Two pure-ish steps, kept separate so the consent gate sits between them:
 *
 *   1. `compileBugReport()` — take the agent's draft, run the mandatory
 *      server-side redaction pipeline over it, stamp the server-known platform
 *      build, and assemble the single editable issue body shown in the consent
 *      card. NOTHING is sent here.
 *   2. `fileBugReport()` — only after the user confirms the card, open the
 *      issue on the fixed upstream repo under the user's OWN GitHub identity.
 *
 * Credential model (docs/164 principle #1): there is no trusted central party
 * in a self-hosted deployment, so the only legitimate credential is the user's
 * own GitHub auth (already held by `GitHubAuthManager` for PRs). The issue is
 * filed as the user — identical to filing it by hand on github.com — so we
 * inherit GitHub's identity and abuse model and add no rate-limiting of our own.
 */

import type { AgentId } from "../../shared/types.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { redact, type ModelRunner } from "./redaction.js";

/**
 * Fixed destination. NOT the user's project repo, and intentionally not env-
 * configurable: a fork that wants its own target changes this constant (a
 * deliberate code edit, not deploy config). See docs/164 "Credential &
 * destination model".
 */
export const UPSTREAM_REPO = { owner: "nicolasalt", repo: "shipit" } as const;

/** Which kind of session produced the report — drives the body marker + label. */
export type BugReportProducer = "session" | "ops";

export interface CompiledBugReport {
  /** Stable id so the card can be updated in place across its lifecycle. */
  cardId: string;
  title: string;
  /**
   * The single editable issue body — exactly what gets filed unless the user
   * edits it. Description + redacted "what happened" + a build/marker footer.
   */
  body: string;
  /** False when the Stage-2 semantic redaction pass didn't run → card flags it. */
  stage2Ran: boolean;
  producer: BugReportProducer;
  /** Bare `SHIPIT_BUILD_ID` commit, or `unknown` on dev/local builds. */
  buildId: string;
}

/** Real label names a push-capable filer (a ShipIt dev) sets directly. */
export function bugReportLabels(producer: BugReportProducer): string[] {
  return ["user-reported", producer === "ops" ? "source:ops" : "source:session"];
}

/**
 * Build the body footer. A *visible* marker line (human-readable) plus a
 * machine-parseable HTML comment, both of which survive even when GitHub drops
 * the `labels` field for a filer without push access — a maintainer-side
 * Action reads the comment and applies the real labels. The footer is part of
 * the editable body (WYSIWYG); the deliberate tradeoff is the user can alter
 * it, which at worst makes a report less useful, never unsafe.
 */
function buildFooter(producer: BugReportProducer, buildId: string): string {
  const source = producer === "ops" ? "ops" : "session";
  return [
    "---",
    `Filed via ShipIt · build ${buildId} · source ${source}`,
    `<!-- shipit-report source=${source} build=${buildId} -->`,
  ].join("\n");
}

/**
 * Compile the agent's draft into a redacted, ready-to-review report. Runs the
 * two-stage redaction pipeline over the agent-authored body (the agent already
 * chose what's relevant when composing it — there is no separate excerpt step),
 * then appends the build/marker footer (non-sensitive, added after redaction).
 *
 * `run` is injectable so tests can drive Stage 2 deterministically; in
 * production it's derived from `agentId` (the session's own CLI).
 */
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

export interface FileBugReportResult {
  success: boolean;
  url?: string;
  number?: number;
  message?: string;
  /** True when the failure is a GitHub permission/scope error → reconnect prompt. */
  scopeError?: boolean;
}

/**
 * File the (possibly user-edited) report as an issue on the upstream repo
 * under the user's own GitHub identity. Labels are passed through but GitHub
 * drops them for filers without push access (the body marker is the durable
 * carrier). Surfaces a scope/permission 403 as a reconnect prompt.
 */
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
