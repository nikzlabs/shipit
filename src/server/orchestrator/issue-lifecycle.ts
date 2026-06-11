/**
 * Issue lifecycle workflow (docs/194) — the orchestrator side that drives an
 * issue's status from session lifecycle, using the docs/177 brokered writes as
 * the mechanism and the docs/177 provenance card as the visible/undo surface.
 *
 * Two transitions, two different sources of truth, and **no session state**:
 *
 *  - **→ started** ({@link markIssueStartedFromSeed}) — a one-shot fired at
 *    session creation when the session is seeded *from* an issue (the Issues-tab
 *    "Start session" action / a future push trigger). The pointer is already in
 *    the creation payload; we act on it once and never persist it.
 *  - **→ completed** ({@link applyMergedPrIssueRefs}) — driven by the merged PR
 *    **body**. When a PR carrying `Closes <pointer>` merges, ShipIt flips the
 *    issue to `completed` and posts a resolved-by comment; `Refs <pointer>`
 *    posts a progress comment only. Parsed by {@link parsePrBodyIssueRefs}.
 *
 * Both reuse the same brokered `status`/`comment` services — the tracker token
 * stays orchestrator-side, the write routes through the `Tracker` adapter, and
 * each surfaces a provenance card with Undo. Neither stores an `issueRef` on the
 * session.
 *
 * Unlike the agent's in-turn writes (api-routes-issues.ts `handleWrite`, which
 * has a live runner and rides the turn via `emitChatCard`), these fire
 * **outside any turn** — seed-time before the first turn settles, merge-time
 * long after the session may have gone idle/archived. So the card is appended
 * directly to chat history (durable, rehydrates on reload) and broadcast live
 * only when a runner is still attached. The undo lifecycle works the same: the
 * undo WS handler re-resolves tracker context from the card's `sessionId`, whose
 * session row (and `remoteUrl`) survives archival.
 */

import { randomUUID } from "node:crypto";
import type { CredentialStore } from "./credential-store.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionManager } from "./sessions.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { IssueRef, IssueWriteCard, TrackerId, WsServerMessage } from "../shared/types.js";
import {
  setIssueStatusForTracker,
  commentOnIssueForTracker,
  type IssueWriteOutcome,
} from "./services/issues.js";
import { resolveGitHubTrackerContext } from "./api-routes-issues.js";
import type { GitHubTrackerContext } from "./trackers/index.js";
import { parseIssueRef, type ParsedIssueRef } from "../shared/issue-ref.js";
import { parsePrBodyIssueRefs } from "../shared/pr-issue-refs.js";

/** Shared collaborators the lifecycle writes need (all orchestrator-side). */
export interface IssueLifecycleDeps {
  credentialStore: CredentialStore;
  trackerFetchImpl?: typeof fetch;
  githubAuthManager: GitHubAuthManager;
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  runnerRegistry: SessionRunnerRegistry;
}

/** The merged-PR facts the completed-on-merge path acts on. */
export interface MergedPrInfo {
  sessionId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  body: string | null | undefined;
}

/**
 * Build the provenance card from a brokered-write outcome and surface it: append
 * it to the session's chat history (durable — rehydrates on reload with its undo
 * state) and broadcast the live `issue_write_card` to any attached viewer. Mirrors
 * the card the route's `handleWrite` builds, minus the live-runner requirement.
 */
function surfaceWriteCard(
  deps: IssueLifecycleDeps,
  sessionId: string,
  trackerId: TrackerId,
  issueId: string,
  outcome: IssueWriteOutcome,
): void {
  const card: IssueWriteCard = {
    cardId: `issue-write-${randomUUID()}`,
    tracker: trackerId,
    issueId: issueId || outcome.issue.id,
    identifier: outcome.issue.identifier,
    title: outcome.issue.title,
    ...(outcome.issue.url ? { url: outcome.issue.url } : {}),
    verb: outcome.verb,
    summary: outcome.summary,
    ...(outcome.content ? { content: outcome.content } : {}),
    attribution: trackerId === "github" ? "user" : "workspace",
    undo: outcome.undo,
    undoState: "available",
    createdAt: new Date().toISOString(),
  };
  deps.chatHistoryManager.append(sessionId, { role: "assistant", text: "", issueWrite: card });
  const runner = deps.runnerRegistry.get(sessionId);
  if (runner) {
    const message: WsServerMessage = { type: "issue_write_card", sessionId, card };
    runner.emitMessage(message);
  }
}

function githubContext(deps: IssueLifecycleDeps, sessionId: string): GitHubTrackerContext {
  return resolveGitHubTrackerContext(deps.githubAuthManager, deps.sessionManager, sessionId);
}

/**
 * Seed path → started. Fire a single brokered `status started` from the pointer
 * the session was created with. Best-effort and idempotent: a tracker that isn't
 * connected, an unresolvable pointer, or an already-started issue must never
 * abort or noisily fail session creation — they log and return.
 *
 * For GitHub, `started` maps to the (open) state, so on an already-open issue
 * this is a harmless no-op; the meaningful case is Linear, where it advances the
 * issue to the team's started state.
 */
export async function markIssueStartedFromSeed(
  deps: IssueLifecycleDeps,
  sessionId: string,
  issueRef: IssueRef,
): Promise<void> {
  // The native id `setStatus` wants comes from parsing the pointer (the bare
  // number for GitHub, the key for Linear) — the display identifier itself isn't
  // a valid `getIssue` id.
  const parsed = parseIssueRef(issueRef.url ?? issueRef.identifier);
  if (parsed.tracker === "unknown" || !parsed.issueId) return;
  const trackerId = issueRef.tracker;
  try {
    const outcome = await setIssueStatusForTracker(
      deps.credentialStore,
      trackerId,
      parsed.issueId,
      "started",
      deps.trackerFetchImpl,
      githubContext(deps, sessionId),
    );
    // Skip the card when nothing actually moved (e.g. an already-open GitHub
    // issue) — a no-op transition isn't worth a transcript row.
    if (outcome.content?.status && outcome.content.status.from === outcome.content.status.to) return;
    surfaceWriteCard(deps, sessionId, trackerId, parsed.issueId, outcome);
  } catch (err) {
    console.warn(`[issue-lifecycle] seed 'started' for ${issueRef.identifier} failed:`, err);
  }
}

/** Post a best-effort comment, surfacing a provenance card. Swallows failures. */
async function comment(
  deps: IssueLifecycleDeps,
  sessionId: string,
  ref: ParsedIssueRef,
  body: string,
): Promise<void> {
  if (!ref.issueId) return;
  try {
    const outcome = await commentOnIssueForTracker(
      deps.credentialStore,
      ref.tracker,
      ref.issueId,
      body,
      deps.trackerFetchImpl,
      githubContext(deps, sessionId),
    );
    surfaceWriteCard(deps, sessionId, ref.tracker as TrackerId, ref.issueId, outcome);
  } catch (err) {
    console.warn(`[issue-lifecycle] comment on ${ref.identifier} failed:`, err);
  }
}

/**
 * Completed-on-merge path. Parse a merged PR's body and, for every pointer it
 * names, broker the corresponding writes:
 *
 *  - `Closes <pointer>` → `status completed` (carded, undoable) **and** a
 *    resolved-by comment (best-effort, supplementary — not separately carded).
 *  - `Refs <pointer>` → a progress comment only (carded), status untouched.
 *
 * A body with no pointer is a no-op (nothing to act on — the multi-PR case).
 * Each pointer is independent and best-effort: one tracker failing doesn't
 * block the others. Multiple `Closes` are all honored (one PR may finish
 * several small issues).
 */
export async function applyMergedPrIssueRefs(
  deps: IssueLifecycleDeps,
  info: MergedPrInfo,
): Promise<void> {
  const { closes, refs } = parsePrBodyIssueRefs(info.body);
  if (closes.length === 0 && refs.length === 0) return;

  const resolvedBy = `Resolved by ShipIt on merge of PR #${info.prNumber}: ${info.prTitle}\n\n${info.prUrl}`;
  const referencedBy = `Referenced by merged PR #${info.prNumber}: ${info.prTitle}\n\n${info.prUrl}`;

  for (const ref of closes) {
    if (!ref.issueId) continue;
    let completed = false;
    try {
      const outcome = await setIssueStatusForTracker(
        deps.credentialStore,
        ref.tracker,
        ref.issueId,
        "completed",
        deps.trackerFetchImpl,
        githubContext(deps, info.sessionId),
      );
      surfaceWriteCard(deps, info.sessionId, ref.tracker as TrackerId, ref.issueId, outcome);
      completed = true;
    } catch (err) {
      console.warn(`[issue-lifecycle] close ${ref.identifier} on merge failed:`, err);
    }
    // Post the resolved-by comment even if the status flip itself failed — the
    // record of "this PR finished it" is still useful. Supplementary, so it
    // rides without its own card.
    if (completed || ref.issueId) {
      await commentSilently(deps, info.sessionId, ref, resolvedBy);
    }
  }

  for (const ref of refs) {
    await comment(deps, info.sessionId, ref, referencedBy);
  }
}

/** A comment with no provenance card — used for the supplementary resolved-by note. */
async function commentSilently(
  deps: IssueLifecycleDeps,
  sessionId: string,
  ref: ParsedIssueRef,
  body: string,
): Promise<void> {
  if (!ref.issueId) return;
  try {
    await commentOnIssueForTracker(
      deps.credentialStore,
      ref.tracker,
      ref.issueId,
      body,
      deps.trackerFetchImpl,
      githubContext(deps, sessionId),
    );
  } catch (err) {
    console.warn(`[issue-lifecycle] resolved-by comment on ${ref.identifier} failed:`, err);
  }
}
