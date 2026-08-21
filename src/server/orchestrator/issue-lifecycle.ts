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
import { buildTrackerRegistry, type GitHubTrackerContext } from "./trackers/index.js";
import { parseIssueRef } from "../shared/issue-ref.js";
import { resolveParsedIssueRef } from "../shared/issue-ref-resolution.js";
import type { TrackerDestination } from "../shared/declared-tracker.js";
import { addressedAsPluginRepo } from "../shared/plugin-feedback.js";
import { isGitHubTracker } from "../shared/tracker-id.js";
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
 *
 * `cardId` is optional. The seed path mints a random id (it fires exactly once at
 * session creation). The merge path passes a DETERMINISTIC id (docs/194 Layer 2)
 * keyed by `(sessionId, prNumber, tracker, issueId, verb)`, so that even if the effect-
 * level guard ever regresses, the client store's idempotent-by-cardId upsert
 * collapses a re-fired card instead of rendering a duplicate.
 */
function surfaceWriteCard(
  deps: IssueLifecycleDeps,
  sessionId: string,
  trackerId: TrackerId,
  trackerName: string | undefined,
  issueId: string,
  outcome: IssueWriteOutcome,
  cardId?: string,
): void {
  // Never push a card into an archived (or vanished) session's transcript. The
  // outward tracker write the caller already performed is correct regardless of
  // local session lifecycle — closing an issue on PR merge should happen whether
  // or not the ShipIt session was archived — but the in-session provenance card
  // is an "update to the session" the archived-receives-nothing invariant
  // forbids. (`fromRow` sets `archived` whenever `userArchived` is set; we check
  // both for belt-and-suspenders parity with the merge-watch guard.)
  const session = deps.sessionManager.get(sessionId);
  if (!session || session.archived || session.userArchived) return;

  const card: IssueWriteCard = {
    cardId: cardId ?? `issue-write-${randomUUID()}`,
    tracker: trackerId,
    // docs/248 — the name the write was addressed by, so Undo follows a
    // re-pointed name (req 16) while still reaching an un-declared destination
    // through `tracker` (req 11).
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

/**
 * docs/248 — the destinations this session can reach, for resolving the
 * references a PR body names. Built from the same registry the routes use, so a
 * `Closes planning#42` resolves through the same declarations an interactive
 * operation would, and an undeclared one fails closed here rather than being
 * routed at the session's own repository (req 11).
 */
function destinationsFor(deps: IssueLifecycleDeps, sessionId: string): TrackerDestination[] {
  return buildTrackerRegistry(
    deps.credentialStore,
    deps.trackerFetchImpl,
    githubContext(deps, sessionId),
  ).destinations();
}

/** The declared name of a destination, when it has one — for the card (req 16). */
function nameForTracker(destinations: TrackerDestination[], trackerId: TrackerId): string | undefined {
  return destinations.find((d) => d.id === trackerId)?.name;
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
  if (!parsed.issueId) return;
  // The destination comes from the seed payload, which the Issues tab already
  // resolved to a declared tracker — not re-resolved here, because this fires at
  // session creation, before the workspace clone is guaranteed to hold the
  // repository's `shipit.yaml`. Only the display name is looked up, and only
  // best-effort.
  const trackerId = issueRef.tracker;
  let trackerName: string | undefined;
  try {
    trackerName = nameForTracker(destinationsFor(deps, sessionId), trackerId);
  } catch {
    /* the card degrades to the destination id — never block the status flip */
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
    // Skip the card when nothing actually moved (e.g. an already-open GitHub
    // issue) — a no-op transition isn't worth a transcript row.
    if (outcome.content?.status && outcome.content.status.from === outcome.content.status.to) return;
    surfaceWriteCard(deps, sessionId, trackerId, trackerName, parsed.issueId, outcome);
  } catch (err) {
    console.warn(`[issue-lifecycle] seed 'started' for ${issueRef.identifier} failed:`, err);
  }
}

/**
 * Run one merge→issue-lifecycle side effect under a persisted, effect-level
 * fire-once guard (docs/194 Layer 1). `key` is the effect's NATURAL identity
 * (`${prNumber}:${tracker}:${issueId}:${verb}` — see {@link effectKey}; the
 * destination is part of it, so two repositories' `#42` are two effects, not one
 * that skips the second), NOT the poller's in-memory `mergedSessions`
 * edge — that edge is wiped on every viewer reconnect (`trackSession`), which is
 * exactly what let each reconnect re-fire these writes and spam duplicate cards /
 * resolved-by comments. The key is recorded ONLY after `effect()` succeeds, so a
 * transient tracker failure leaves it unset and a later re-fire (reconnect or
 * restart reconcile) retries it. Best-effort: never throws into the poller.
 */
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
    // docs/248-declared-issue-trackers req 19 — an unreachable destination is a failure the user must
    // see, not just a server log. The effect itself stays retryable (its key is
    // unrecorded), so the REPORT gets its own fire-once key: a transient failure
    // that later succeeds leaves one note behind, not one per reconnect re-fire.
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

/**
 * Report a lifecycle failure into the session's transcript (docs/248-declared-issue-trackers req 19: a
 * failure "is never silently dropped"). These fire outside any turn, so — like
 * {@link surfaceWriteCard} — the message is appended straight to chat history
 * (durable, rehydrates on reload) and broadcast only if a viewer is attached.
 *
 * Plain text rather than a typed card on purpose: a card would need the whole
 * persisted-card recipe in `CLAUDE.md` (new field, column, migration,
 * `CARD_MESSAGE_FIELDS`), and this carries no state, no action and no undo —
 * there is nothing for the user to do but read it.
 *
 * History-only, with no live broadcast: there is no generic "assistant text" WS
 * message to emit, and minting one (plus its client handler and
 * `TRANSCRIPT_SCOPED_MESSAGES` entry) buys very little here — a merge effect
 * fires long after the turn, usually with no viewer attached. Persisted is the
 * transcript; an attached viewer sees it on its next rehydrate.
 *
 * `key` makes it fire once. Merge effects re-fire on every viewer reconnect, so
 * without it a permanently-unresolvable reference would append a fresh copy of
 * the same sentence each time the session is reopened.
 */
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

/**
 * Natural identity of one merge→issue effect. The DESTINATION is part of it
 * (docs/248): a PR may legitimately name `alpha#42` and `beta#42`, which are two
 * different issues in two different trackers. Keyed on the issue number alone,
 * the second one looks like an already-applied effect and is silently skipped —
 * so one of the two issues never gets completed.
 */
function effectKey(prNumber: number, tracker: TrackerId, issueId: string, verb: string): string {
  return `${prNumber}:${tracker}:${issueId}:${verb}`;
}

/**
 * Deterministic card id for a merge-driven write (docs/194 Layer 2). Carries the
 * destination for the same reason {@link effectKey} does — without it the two
 * cards for `alpha#42` and `beta#42` collide on one id, and the second write's
 * card overwrites the first's in the transcript.
 */
function mergeCardId(
  sessionId: string,
  prNumber: number,
  tracker: TrackerId,
  issueId: string,
  verb: string,
): string {
  return `issue-write-${sessionId}-${prNumber}-${tracker}-${issueId}-${verb}`;
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

  // docs/248-declared-issue-trackers reqs 10/11 — a PR body may name a destination by declared name
  // (`Closes planning#42`) or by canonical address. Both resolve through the
  // session repository's declarations; one that identifies no declared
  // destination is dropped rather than routed at the session's own repository,
  // which is the wrong-target bug this feature exists to prevent.
  const destinations = destinationsFor(deps, info.sessionId);
  const resolveRef = (ref: (typeof closes)[number]) => {
    const resolution = resolveParsedIssueRef(ref, destinations);
    if (!resolution.ok) {
      console.warn(
        `[issue-lifecycle] PR #${info.prNumber} names \`${ref.identifier}\`, which does not resolve: ${resolution.message}`,
      );
      // req 19 — this drop is PERMANENT (re-firing re-derives the same failure
      // from the same PR body), so a log alone would mean the user's `Closes`
      // silently did nothing: the PR merges, the issue stays open, and nothing
      // anywhere says why.
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
    // docs/262 req 25 — a declared plugin repository is a FEEDBACK destination.
    // Merging a project PR cannot have fixed a plugin: req 7 keeps the plugin
    // checkout read-only and a project session never pushes there, so the fix
    // by definition landed somewhere else. Completing the issue anyway would
    // close a third party's report on the strength of an unrelated merge, so
    // this refuses and says why rather than acting. `Refs` still works and is
    // the pointer that means what the author meant here.
    //
    // Keyed on the NAME the pointer used, so a repository the project declares
    // both ways behaves as the pointer asked: `Closes planning#12` completes an
    // issue on the project's own tracker, `Closes tools#12` does not.
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
    // Status flip + provenance card — guarded so a reconnect-driven re-fire
    // can't re-promote an already-completed issue or re-card it.
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
    // Resolved-by comment — supplementary (no card), so it rides under its OWN
    // guard key. This keeps the original "post the comment even if the status
    // flip failed" semantics (independent effects) while making it fire once.
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
    // Progress comment + card — same root cause re-fires this on reconnect, so
    // it gets its own guard key and a deterministic card id too.
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
