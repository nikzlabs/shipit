import type { WsServerMessage } from "../../shared/types.js";
import type { DecisionCardField, DecisionCardOf } from "../chat-history.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import {
  persistTurnInProgress,
  updateRecordedCard,
  type InProgressPersister,
} from "../chat-card-persistence.js";
import { ServiceError } from "./types.js";

/**
 * The claim of a user's decision on a card, for every card kind
 * (docs/324-scheduled-sessions plan.md → Cards: proposals and approvals). It is
 * docs/299-agent-settings-access's settings claim with the settings-specific
 * parts moved into {@link DecisionCardKind}; settings proposals are the first
 * kind (`settings-proposal.ts`).
 *
 * A decision reaches these functions only from the browser: the settings
 * decision arrives on the session WebSocket, which no session container may
 * open (`api-container-guard.ts`). A kind's decision transport must stay
 * browser-only too, or an agent could decide its own card.
 */

export type DecisionCardPhase<F extends DecisionCardField> = DecisionCardOf<F>["phase"];

/** What one kind supplies to the shared claim. */
export interface DecisionCardKind<F extends DecisionCardField> {
  /** The transcript field the card lives on; the claim updates this field. */
  readonly field: F;
  /** How a refusal names the card: "That {noun} is not in this session." */
  readonly noun: string;
  /** The live message that tells every viewer the card moved. */
  updated(sessionId: string, cardId: string, card: DecisionCardOf<F>): WsServerMessage;
}

/**
 * A kind's private record of a card, beside its transcript row. It holds what
 * the decision acts on, so a decision loads it rather than trusting the client.
 * The phase is kept here and on the card, and only this module moves both.
 */
export interface DecisionRecordStore<Phase extends string, Row extends { sessionId: string }> {
  get(cardId: string): Row | null;
  /** The record and the transcript row commit together, in the same database. */
  transaction<T>(fn: () => T): T;
  setPhase(sessionId: string, cardId: string, phase: Phase, resolvedAt?: string): boolean;
  /** Moves the record only from `from`; false when it is no longer there. */
  claimPhase(sessionId: string, cardId: string, from: Phase, to: Phase, resolvedAt?: string): boolean;
}

export interface DecisionCardPersister extends InProgressPersister {
  getDecisionCard<F extends DecisionCardField>(
    field: F,
    sessionId: string,
    cardId: string,
  ): DecisionCardOf<F> | undefined;
  updateDecisionCard<F extends DecisionCardField>(
    field: F,
    sessionId: string,
    cardId: string,
    patch: Partial<DecisionCardOf<F>>,
  ): DecisionCardOf<F> | null;
}

export interface CardClaimDeps<F extends DecisionCardField, Row extends { sessionId: string }> {
  chatHistoryManager: DecisionCardPersister;
  records: DecisionRecordStore<DecisionCardPhase<F>, Row>;
  getRunnerRegistry: () => SessionRunnerRegistry | undefined;
}

/** A patch to the card. `phase` and `resolvedAt` go to the record as well. */
export type DecisionCardPatch<F extends DecisionCardField> = Partial<DecisionCardOf<F>> & {
  phase: DecisionCardPhase<F>;
  resolvedAt?: string;
};

function notInSession(kind: { noun: string }): ServiceError {
  return new ServiceError(404, `That ${kind.noun} is not in this session.`);
}

/**
 * The first step of every decision: the card's record AND its transcript row
 * must exist in this session, or the decision is refused before anything is
 * written. Session-scoped, because a card id is the client's to name, and a
 * decision under another session must not reach a card that shares the id.
 */
export function loadDecisionCard<F extends DecisionCardField, Row extends { sessionId: string }>(
  kind: DecisionCardKind<F>,
  deps: CardClaimDeps<F, Row>,
  sessionId: string,
  cardId: string,
): { record: Row; card: DecisionCardOf<F> } {
  const record = deps.records.get(cardId);
  const card = record?.sessionId === sessionId
    ? deps.chatHistoryManager.getDecisionCard(kind.field, sessionId, cardId)
    : undefined;
  if (!record || !card) throw notInSession(kind);
  return { record, card };
}

/** The card as it stands, for a decision that found nothing to do. */
export function currentDecisionCard<F extends DecisionCardField>(
  kind: DecisionCardKind<F>,
  deps: Pick<CardClaimDeps<F, { sessionId: string }>, "chatHistoryManager">,
  sessionId: string,
  cardId: string,
): DecisionCardOf<F> {
  const card = deps.chatHistoryManager.getDecisionCard(kind.field, sessionId, cardId);
  if (!card) throw notInSession(kind);
  return card;
}

/** A claim against a card the transcript no longer holds; rolls the record back. */
class CardRowMissing extends Error {}

/**
 * **The one transition contract.** Every phase change a card ever makes goes
 * through here or through the claim below.
 *
 * It is not `persistCardTransition`. That helper requires a runner and runs its
 * database callback ONLY when it did not patch an in-flight card, so a card
 * resolved through it can end durable-but-unsynchronised, or synchronised but
 * never written down. A card is clicked hours after its turn as often as during
 * one, and the post-turn lease is no substitute (`POST_TURN_HOLD_MAX_MS` is
 * 120 s), so neither half may be conditional on the other.
 *
 * So, in order:
 *
 *  1. the transcript row and the record, in ONE transaction and **whether or not
 *     a runner exists** — a phase in one but not the other is the split this
 *     contract exists to prevent;
 *  2. only then, and only if a runner exists, the copy the turn is holding plus
 *     the live emit.
 *
 * The transcript lookup is session-scoped and gates the record write, so a
 * decision that cannot find the card in this session cannot reach a record that
 * shares its id.
 */
export function transitionDecisionCard<F extends DecisionCardField, Row extends { sessionId: string }>(
  kind: DecisionCardKind<F>,
  deps: CardClaimDeps<F, Row>,
  sessionId: string,
  cardId: string,
  patch: DecisionCardPatch<F>,
): DecisionCardOf<F> | null {
  const card = deps.records.transaction(() => {
    const updated = deps.chatHistoryManager.updateDecisionCard(kind.field, sessionId, cardId, patch);
    if (!updated) return null;
    deps.records.setPhase(sessionId, cardId, patch.phase, patch.resolvedAt);
    return updated;
  });
  if (!card) return null;
  syncRecordedCard(kind, deps, sessionId, cardId, card);
  return card;
}

/**
 * **The claim**: the phase moves only if it is still `from`, and the card the
 * user sees moves with it in the same transaction.
 *
 * Both halves are the point. A database-only claim is undone when the next turn
 * snapshot rebuilds the in-progress rows from `recordedCards`
 * (`chat-history.ts` → `replaceInProgress`), which puts a pending card back in
 * front of the user — so a second click claims it again. And the conditional
 * update IS the test: of two racing clicks, the loser changes no rows.
 *
 * `null` when nothing was claimed: the record left `from` first, or the card or
 * its record is gone. Nothing is written in either case.
 */
export function claimDecisionCard<F extends DecisionCardField, Row extends { sessionId: string }>(
  kind: DecisionCardKind<F>,
  deps: CardClaimDeps<F, Row>,
  sessionId: string,
  cardId: string,
  from: DecisionCardPhase<F>,
  patch: DecisionCardPatch<F>,
): DecisionCardOf<F> | null {
  let card: DecisionCardOf<F> | null;
  try {
    card = deps.records.transaction(() => {
      if (!deps.records.claimPhase(sessionId, cardId, from, patch.phase, patch.resolvedAt)) {
        return null;
      }
      const updated = deps.chatHistoryManager.updateDecisionCard(kind.field, sessionId, cardId, patch);
      // Throwing rolls the record back with it, rather than leaving a card
      // claimed against a transcript that does not show it.
      if (!updated) throw new CardRowMissing();
      return updated;
    });
  } catch (err) {
    if (err instanceof CardRowMissing) return null;
    throw err;
  }
  if (!card) return null;
  syncRecordedCard(kind, deps, sessionId, cardId, card);
  return card;
}

/**
 * The runner half of a transition: the copy the turn is holding, and the live
 * emit. With no runner the durable row stands on its own.
 *
 * The snapshot rewrite is narrower than the patch, and must be:
 * `recordedCards` is cleared at the start of the NEXT turn
 * (`resetRunnerTurnState`), so a card resolved after its turn ended is still
 * there to patch. Rebuilding the snapshot then would re-insert the finished turn
 * as in-progress rows beside the finalized ones.
 */
function syncRecordedCard<F extends DecisionCardField, Row extends { sessionId: string }>(
  kind: DecisionCardKind<F>,
  deps: CardClaimDeps<F, Row>,
  sessionId: string,
  cardId: string,
  card: DecisionCardOf<F>,
): void {
  const runner = deps.getRunnerRegistry()?.get(sessionId);
  if (!runner) return;

  const patched = updateRecordedCard(
    runner,
    (m) => m[kind.field]?.cardId === cardId,
    (m) => ({ ...m, [kind.field]: card }),
  );
  // `running` alone is not enough: it goes true before the previous turn's cards
  // are cleared.
  const ownsInProgressRows =
    runner.running && (deps.chatHistoryManager.hasInProgress?.(sessionId) ?? true);
  if (patched && ownsInProgressRows) {
    persistTurnInProgress(deps.chatHistoryManager, runner, sessionId);
    if (typeof runner.getTurnEventBuffer === "function") {
      runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;
    }
  }
  runner.emitMessage(kind.updated(sessionId, cardId, card));
}
