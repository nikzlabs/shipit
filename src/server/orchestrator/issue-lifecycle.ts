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
import { buildTrackerRegistry, type GitHubTrackerContext } from "./trackers/index.js";
import { parseIssueRef } from "../shared/issue-ref.js";
import { resolveParsedIssueRef } from "../shared/issue-ref-resolution.js";
import type { TrackerDestination } from "../shared/declared-tracker.js";
import { addressedAsPluginRepo } from "../shared/plugin-feedback.js";
import { isGitHubTracker } from "../shared/tracker-id.js";
import { parsePrBodyIssueRefs } from "../shared/pr-issue-refs.js";

export interface IssueLifecycleDeps {
  credentialStore: CredentialStore;
  trackerFetchImpl?: typeof fetch;
  githubAuthManager: GitHubAuthManager;
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  runnerRegistry: SessionRunnerRegistry;
}

export interface MergedPrInfo {
  sessionId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  body: string | null | undefined;
}

// These writes can occur outside a turn; persist cards directly before broadcasting.
function surfaceWriteCard(
  deps: IssueLifecycleDeps,
  sessionId: string,
  trackerId: TrackerId,
  trackerName: string | undefined,
  issueId: string,
  outcome: IssueWriteOutcome,
  cardId?: string,
): void {
  // Archival suppresses the card, not the completed tracker write.
  const session = deps.sessionManager.get(sessionId);
  if (!session || session.archived || session.userArchived) return;

  const card: IssueWriteCard = {
    cardId: cardId ?? `issue-write-${randomUUID()}`,
    tracker: trackerId,
    ...(trackerName ? { trackerName } : {}),
    issueId: issueId || outcome.issue.id,
    identifier: outcome.issue.identifier,
    title: outcome.issue.title,
    ...(outcome.issue.url ? { url: outcome.issue.url } : {}),
    verb: outcome.verb,
    summary: outcome.summary,
    ...(outcome.content ? { content: outcome.content } : {}),
    attribution: isGitHubTracker(trackerId) ? "user" : "workspace",
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

function destinationsFor(deps: IssueLifecycleDeps, sessionId: string): TrackerDestination[] {
  return buildTrackerRegistry(
    deps.credentialStore,
    deps.trackerFetchImpl,
    githubContext(deps, sessionId),
  ).destinations();
}

function nameForTracker(destinations: TrackerDestination[], trackerId: TrackerId): string | undefined {
  return destinations.find((d) => d.id === trackerId)?.name;
}

export async function markIssueStartedFromSeed(
  deps: IssueLifecycleDeps,
  sessionId: string,
  issueRef: IssueRef,
): Promise<void> {
  const parsed = parseIssueRef(issueRef.url ?? issueRef.identifier);
  if (!parsed.issueId) return;
  // Use the resolved seed destination: the clone may not yet contain shipit.yaml.
  const trackerId = issueRef.tracker;
  let trackerName: string | undefined;
  try {
    trackerName = nameForTracker(destinationsFor(deps, sessionId), trackerId);
  } catch {
    /* Use the destination id if name lookup fails. */
  }
  try {
    const outcome = await setIssueStatusForTracker(
      deps.credentialStore,
      trackerId,
      parsed.issueId,
      "started",
      deps.trackerFetchImpl,
      githubContext(deps, sessionId),
    );
    if (outcome.content?.status && outcome.content.status.from === outcome.content.status.to) return;
    surfaceWriteCard(deps, sessionId, trackerId, trackerName, parsed.issueId, outcome);
  } catch (err) {
    console.warn(`[issue-lifecycle] seed 'started' for ${issueRef.identifier} failed:`, err);
  }
}

// Persist successful effects because reconnects can repeat merge notifications.
async function runMergeEffect(
  deps: IssueLifecycleDeps,
  sessionId: string,
  key: string,
  effect: () => Promise<void>,
): Promise<void> {
  if (deps.sessionManager.hasAppliedMergeIssueEffect(sessionId, key)) return;
  try {
    await effect();
    deps.sessionManager.markAppliedMergeIssueEffect(sessionId, key);
  } catch (err) {
    console.warn(`[issue-lifecycle] merge effect ${key} failed:`, err);
    // Deduplicate the report separately so the failed effect can retry.
    surfaceLifecycleFailure(
      deps,
      sessionId,
      `${key}:reported`,
      `Could not apply a merge update to \`${key.split(":")[2] ?? "the issue"}\`: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// History only: an attached viewer sees the failure on its next history reload.
function surfaceLifecycleFailure(
  deps: IssueLifecycleDeps,
  sessionId: string,
  key: string,
  text: string,
): void {
  const session = deps.sessionManager.get(sessionId);
  if (!session || session.archived || session.userArchived) return;
  if (deps.sessionManager.hasAppliedMergeIssueEffect(sessionId, key)) return;
  deps.sessionManager.markAppliedMergeIssueEffect(sessionId, key);
  deps.chatHistoryManager.append(sessionId, { role: "assistant", text });
}

function effectKey(prNumber: number, tracker: TrackerId, issueId: string, verb: string): string {
  return `${prNumber}:${tracker}:${issueId}:${verb}`;
}

function mergeCardId(
  sessionId: string,
  prNumber: number,
  tracker: TrackerId,
  issueId: string,
  verb: string,
): string {
  return `issue-write-${sessionId}-${prNumber}-${tracker}-${issueId}-${verb}`;
}

export async function applyMergedPrIssueRefs(
  deps: IssueLifecycleDeps,
  info: MergedPrInfo,
): Promise<void> {
  const { closes, refs } = parsePrBodyIssueRefs(info.body);
  if (closes.length === 0 && refs.length === 0) return;

  const destinations = destinationsFor(deps, info.sessionId);
  const resolveRef = (ref: (typeof closes)[number]) => {
    const resolution = resolveParsedIssueRef(ref, destinations);
    if (!resolution.ok) {
      console.warn(
        `[issue-lifecycle] PR #${info.prNumber} names \`${ref.identifier}\`, which does not resolve: ${resolution.message}`,
      );
      surfaceLifecycleFailure(
        deps,
        info.sessionId,
        `${info.prNumber}:${ref.identifier}:unresolved`,
        `PR #${info.prNumber} names \`${ref.identifier}\`, but ShipIt could not act on it: ${resolution.message}`,
      );
      return null;
    }
    return resolution.ref;
  };

  const resolvedBy = `Resolved by ShipIt on merge of PR #${info.prNumber}: ${info.prTitle}\n\n${info.prUrl}`;
  const referencedBy = `Referenced by merged PR #${info.prNumber}: ${info.prTitle}\n\n${info.prUrl}`;

  for (const parsedRef of closes) {
    const ref = resolveRef(parsedRef);
    if (!ref) continue;
    // A project merge cannot close plugin feedback; resolve the pointer's named alias.
    const destination = destinations.find((d) => d.id === ref.tracker);
    if (addressedAsPluginRepo(destination, ref.trackerName)) {
      surfaceLifecycleFailure(
        deps,
        info.sessionId,
        `${info.prNumber}:${ref.identifier}:plugin-closes`,
        `PR #${info.prNumber} says it closes \`${ref.identifier}\`, but \`${ref.trackerName ?? ref.tracker}\` is a declared plugin repository, not one of this project's trackers. ` +
          "A project session never changes a plugin, so ShipIt left that issue open — fix it in the plugin's own repository, and use `Refs` here to leave a reference.",
      );
      continue;
    }
    const issueId = ref.issueId;
    await runMergeEffect(deps, info.sessionId, effectKey(info.prNumber, ref.tracker, issueId, "completed"), async () => {
      const outcome = await setIssueStatusForTracker(
        deps.credentialStore,
        ref.tracker,
        issueId,
        "completed",
        deps.trackerFetchImpl,
        githubContext(deps, info.sessionId),
      );
      surfaceWriteCard(
        deps,
        info.sessionId,
        ref.tracker,
        ref.trackerName,
        issueId,
        outcome,
        mergeCardId(info.sessionId, info.prNumber, ref.tracker, issueId, "completed"),
      );
    });
    // Post the comment independently, even if the status change failed.
    await runMergeEffect(deps, info.sessionId, effectKey(info.prNumber, ref.tracker, issueId, "resolved-comment"), async () => {
      await commentOnIssueForTracker(
        deps.credentialStore,
        ref.tracker,
        issueId,
        resolvedBy,
        deps.trackerFetchImpl,
        githubContext(deps, info.sessionId),
      );
    });
  }

  for (const parsedRef of refs) {
    const ref = resolveRef(parsedRef);
    if (!ref) continue;
    const issueId = ref.issueId;
    await runMergeEffect(deps, info.sessionId, effectKey(info.prNumber, ref.tracker, issueId, "referenced-comment"), async () => {
      const outcome = await commentOnIssueForTracker(
        deps.credentialStore,
        ref.tracker,
        issueId,
        referencedBy,
        deps.trackerFetchImpl,
        githubContext(deps, info.sessionId),
      );
      surfaceWriteCard(
        deps,
        info.sessionId,
        ref.tracker,
        ref.trackerName,
        issueId,
        outcome,
        mergeCardId(info.sessionId, info.prNumber, ref.tracker, issueId, "refs"),
      );
    });
  }
}
