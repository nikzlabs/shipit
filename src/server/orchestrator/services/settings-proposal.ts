import { randomUUID } from "node:crypto";
import type {
  SettingsProposalCard,
  SettingsProposalOperation,
  SettingsProposalPhase,
  SettingsProposalSideChange,
  SettingsProposalTarget,
} from "../../shared/types.js";
import { findSetting, settingPath } from "../../shared/settings-catalogue/index.js";
import { ServiceError } from "./types.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SettingsProposalStore } from "../settings-proposal-store.js";
import {
  emitChatCard,
  persistTurnInProgress,
  updateRecordedCard,
  type InProgressPersister,
} from "../chat-card-persistence.js";

/**
 * The settings proposal card as a transcript object (docs/299-agent-settings-access
 * req 4): how one is written, and the single way its phase ever changes.
 *
 * What proposes a change, and what resolves one, live elsewhere. This file owns
 * the invariant both of them depend on: **a card's durable row and the copy a
 * viewer is looking at never disagree.**
 */

/**
 * The agent's reason is untrusted text — it can come from a repository file, a
 * web page or a tool result by way of the agent. It is flattened to one line and
 * capped exactly as a bug-report title is (`services/bug-report.ts`), so it
 * cannot add lines to the card or push ShipIt's own words off it.
 *
 * This is presentation hygiene and NOT the secret defence: the projections are
 * that. Nothing in the reason is ever read back as a fact about the change —
 * the setting, `from` and `to` come from the registry and the server's own read.
 */
export const PROPOSAL_REASON_MAX = 200;

export function flattenProposalReason(reason: string | undefined): string | undefined {
  if (typeof reason !== "string") return undefined;
  const flat = reason.replace(/\s+/g, " ").trim().slice(0, PROPOSAL_REASON_MAX);
  return flat.length > 0 ? flat : undefined;
}

export interface SettingsProposalPersister extends InProgressPersister {
  updateSettingsProposalCard(
    sessionId: string,
    cardId: string,
    patch: Partial<SettingsProposalCard>,
  ): SettingsProposalCard | null;
}

export interface SettingsProposalDeps {
  chatHistoryManager: SettingsProposalPersister;
  proposals: SettingsProposalStore;
  getRunnerRegistry: () => SessionRunnerRegistry | undefined;
}

type ProposalRunner = Pick<
  SessionRunnerInterface,
  | "emitMessage"
  | "running"
  | "chatMessageGroups"
  | "recordedCards"
  | "steeredMessages"
  | "getTurnEventBuffer"
  | "lastPersistedBufferIndex"
>;

export interface PostSettingsProposalArgs {
  sessionId: string;
  /** The setting the card is about. Its declaration is looked up, never passed in. */
  target: SettingsProposalTarget;
  /** What the click will do, which the decision runs and the message never says. */
  operation: SettingsProposalOperation;
  /** Both already through the catalogue's formatting door. */
  from: string;
  to: string;
  /** The rest of what this one operation writes, through the same door. */
  alsoChanges?: SettingsProposalSideChange[];
  /** The projected current value and the value to write, for the private row. */
  fromValue: unknown;
  proposedValue: unknown;
  /**
   * The revision of the WHOLE stored value at propose time — server-only, and
   * what the apply compares against instead of the displayed `from`.
   */
  baseline: unknown;
  reason?: string | undefined;
}

/**
 * Write a proposal: the private row first, then the card.
 *
 * The card's words — its label, its description and its breadcrumb — are read
 * off the declaration the TARGET names, so what the card says and what the
 * button writes cannot be two different settings. Everything else ShipIt
 * asserts (`from`, `to`) is the caller's own read through the catalogue's
 * projection door; the agent contributes only `reason`.
 *
 * The order matters. A card the user can click before its row exists is a click
 * that loads nothing, so the row — which is what a decision loads, claims and
 * applies from — is written before anything reaches a viewer.
 *
 * The card goes out through `emitChatCard` and never a bare `emitMessage`: a
 * propose from a backgrounded `shipit agent run` can land after the turn has
 * ended, and `emitChatCard` is what decides between riding the in-progress turn
 * and appending an already-final row. Hand-rolling that at a post-turn call site
 * revives a finished turn as `in_progress=1`, which the next turn's
 * `replaceInProgress` then deletes wholesale (docs/236).
 */
export function postSettingsProposal(
  deps: Pick<SettingsProposalDeps, "chatHistoryManager" | "proposals">,
  // An argument rather than a registry lookup: a propose comes from inside the
  // session's own container, so its runner exists by construction. A DECISION
  // does not, which is why the transition below resolves one and copes without.
  runner: ProposalRunner,
  args: PostSettingsProposalArgs,
): SettingsProposalCard {
  const { sessionId } = args;
  // Resolved here rather than accepted from the caller, so the words on the card
  // and the setting the button writes cannot be two different settings.
  const declaration = findSetting(args.target.key);
  if (!declaration) {
    throw new ServiceError(400, `No ShipIt setting is called "${args.target.key}".`);
  }
  const createdAt = new Date().toISOString();
  const reason = flattenProposalReason(args.reason);
  const card: SettingsProposalCard = {
    cardId: `set-${randomUUID()}`,
    target: args.target,
    label: declaration.label,
    description: declaration.description,
    path: settingPath(declaration.tab),
    from: args.from,
    to: args.to,
    ...(args.alsoChanges && args.alsoChanges.length > 0 ? { alsoChanges: args.alsoChanges } : {}),
    ...(reason ? { reason } : {}),
    phase: "pending",
    createdAt,
  };

  deps.proposals.create({
    cardId: card.cardId,
    sessionId,
    target: args.target,
    operation: args.operation,
    phase: "pending",
    from: args.fromValue,
    proposed: args.proposedValue,
    baseline: args.baseline,
    createdAt,
  });

  const persisted: PersistedMessage = { role: "assistant", text: "", settingsProposal: card };
  emitChatCard(
    runner,
    { type: "settings_proposal_card", sessionId, card },
    persisted,
    { chatHistoryManager: deps.chatHistoryManager, sessionId },
  );
  return card;
}

/** A claim against a card the transcript no longer holds; rolls the phase back. */
class CardRowMissing extends Error {}

export interface SettingsProposalTransition {
  phase: SettingsProposalPhase;
  /** Stamped on any phase that ends the card; omitted for the claim. */
  resolvedAt?: string;
  outcome?: string;
  outcomeDetail?: string;
  effect?: SettingsProposalCard["effect"];
}

/**
 * **The one transition contract.** Every phase change a settings proposal ever
 * makes — the claim, a dismissal, a terminal answer — goes through here.
 *
 * It is not `persistCardTransition`. That helper requires a runner and runs its
 * database callback ONLY when it did not patch an in-flight card, so a card
 * resolved through it can end durable-but-unsynchronised, or synchronised but
 * never written down. A settings card is clicked hours after its turn as often
 * as during one, and the post-turn lease is no substitute
 * (`POST_TURN_HOLD_MAX_MS` is 120 s), so neither half may be conditional on the
 * other.
 *
 * So, in order:
 *
 *  1. the durable row and the private row, in ONE transaction and **whether or
 *     not a runner exists** — this is what the next decision, the next read and
 *     the next boot see, and a phase in one but not the other is the split this
 *     contract exists to prevent;
 *  2. only then, and only if a runner exists, the copy the turn is holding plus
 *     the live emit.
 *
 * A database-only write can still be undone by the next turn snapshot rebuilding
 * the in-progress rows from `recordedCards` — which is why step 2 patches them
 * rather than leaving the rebuild to reproduce a stale card. Where there is no
 * runner at all there is nothing to rebuild from, so the durable row stands.
 *
 * The **snapshot** rewrite in step 2 is narrower than the patch, and must be:
 * `recordedCards` is cleared at the start of the NEXT turn, not at the end of
 * this one (`resetRunnerTurnState`), so a card resolved in the gap is still
 * there to patch while its turn is finished and its rows finalized. Rebuilding
 * the snapshot then re-inserts the whole finished turn as in-progress rows
 * beside the finalized ones, and the user sees their last turn twice.
 */
export function transitionSettingsProposal(
  deps: SettingsProposalDeps,
  sessionId: string,
  cardId: string,
  transition: SettingsProposalTransition,
): SettingsProposalCard | null {
  const patch: Partial<SettingsProposalCard> = {
    phase: transition.phase,
    ...(transition.resolvedAt ? { resolvedAt: transition.resolvedAt } : {}),
    ...(transition.outcome ? { outcome: transition.outcome } : {}),
    ...(transition.outcomeDetail ? { outcomeDetail: transition.outcomeDetail } : {}),
    ...(transition.effect ? { effect: transition.effect } : {}),
  };

  const card = deps.proposals.transaction(() => {
    // Session-scoped, and it gates the private write: a card id names a row in
    // one session's transcript, so a decision that cannot find it there must not
    // reach the proposal it happens to share an id with.
    const updated = deps.chatHistoryManager.updateSettingsProposalCard(sessionId, cardId, patch);
    if (!updated) return null;
    deps.proposals.setPhase(sessionId, cardId, transition.phase, transition.resolvedAt);
    return updated;
  });
  if (!card) return null;
  syncRecordedCard(deps, sessionId, cardId, card);
  return card;
}

/**
 * **The claim**, and the same contract from the other end: the phase moves only
 * if it is still the one the caller found, and the card the user is looking at
 * moves with it in the same transaction.
 *
 * Both halves are the point. A database-only claim is undone the moment the next
 * turn snapshot rebuilds the in-progress rows from `recordedCards`
 * (`chat-history.ts` → `replaceInProgress`), which puts a `pending` card back in
 * front of the user over a proposal already being applied — so the second click
 * claims it again and the change is applied twice. And the conditional update IS
 * the test: two clicks racing produce one claim, because the loser changes no
 * rows rather than reading a phase that a rival is about to overwrite.
 */
export function claimSettingsProposal(
  deps: SettingsProposalDeps,
  sessionId: string,
  cardId: string,
  from: SettingsProposalPhase,
  transition: SettingsProposalTransition,
): SettingsProposalCard | null {
  const patch: Partial<SettingsProposalCard> = {
    phase: transition.phase,
    ...(transition.resolvedAt ? { resolvedAt: transition.resolvedAt } : {}),
    ...(transition.outcome ? { outcome: transition.outcome } : {}),
  };
  let card: SettingsProposalCard | null;
  try {
    card = deps.proposals.transaction(() => {
      if (!deps.proposals.claimPhase(sessionId, cardId, from, transition.phase, transition.resolvedAt)) {
        return null;
      }
      const updated = deps.chatHistoryManager.updateSettingsProposalCard(sessionId, cardId, patch);
      // No card row means no card to claim. Throwing rolls the phase back with
      // it, rather than leaving a proposal claimed against a transcript that
      // never showed it.
      if (!updated) throw new CardRowMissing();
      return updated;
    });
  } catch (err) {
    if (err instanceof CardRowMissing) return null;
    throw err;
  }
  if (!card) return null;
  syncRecordedCard(deps, sessionId, cardId, card);
  return card;
}

/**
 * The runner half of a transition: the copy the turn is holding, and the live
 * emit. Where there is no runner there is nothing to rebuild from, so the
 * durable row stands on its own — which is what lets a card be resolved hours
 * after its turn ended.
 */
function syncRecordedCard(
  deps: SettingsProposalDeps,
  sessionId: string,
  cardId: string,
  card: SettingsProposalCard,
): void {
  const runner = deps.getRunnerRegistry()?.get(sessionId);
  if (!runner) return;

  const patched = updateRecordedCard(
    runner,
    (m) => m.settingsProposal?.cardId === cardId,
    (m) => ({ ...m, settingsProposal: card }),
  );
  // `running` alone is not enough: it goes true before the previous turn's cards
  // are cleared, so the snapshot is rewritten only when rows actually exist to
  // replace.
  const ownsInProgressRows =
    runner.running && (deps.chatHistoryManager.hasInProgress?.(sessionId) ?? true);
  if (patched && ownsInProgressRows) {
    persistTurnInProgress(deps.chatHistoryManager, runner, sessionId);
    if (typeof runner.getTurnEventBuffer === "function") {
      runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;
    }
  }
  runner.emitMessage({ type: "settings_proposal_update", sessionId, cardId, card });
}
