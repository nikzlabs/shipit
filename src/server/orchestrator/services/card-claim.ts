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
 * (docs/324-scheduled-sessions plan.md → Cards: proposals and approvals; the
 * contract's argument is docs/299-agent-settings-access plan.md).
 *
 * A kind's decision transport must stay browser-only, or an agent could decide
 * its own card: the settings decision arrives on the session WebSocket, which no
 * session container may open (`api-container-guard.ts`).
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

/** A half of the card has gone, or another click claimed it first; throwing rolls back what was written. */
class CardHalfMissing extends Error {}

function bothHalves<T>(write: () => T | null): T | null {
  try {
    return write();
  } catch (err) {
    if (err instanceof CardHalfMissing) return null;
    throw err;
  }
}

/**
 * **The one transition contract** for every phase change outside the claim.
 * Not `persistCardTransition`, which writes the database only when it patched
 * no in-flight card: a card is clicked hours after its turn as often as during
 * it, so neither half may depend on a runner.
 *
 *  1. The transcript row and the record, in ONE transaction, with or without a
 *     runner. Both change or neither does; the session-scoped transcript lookup
 *     goes first, so a card id from another session reaches no record.
 *  2. Then, only if a runner exists, the turn's copy and the live emit.
 */
export function transitionDecisionCard<F extends DecisionCardField, Row extends { sessionId: string }>(
  kind: DecisionCardKind<F>,
  deps: CardClaimDeps<F, Row>,
  sessionId: string,
  cardId: string,
  patch: DecisionCardPatch<F>,
): DecisionCardOf<F> | null {
  const card = bothHalves(() => deps.records.transaction(() => {
    const updated = deps.chatHistoryManager.updateDecisionCard(kind.field, sessionId, cardId, patch);
    if (!updated) return null;
    if (!deps.records.setPhase(sessionId, cardId, patch.phase, patch.resolvedAt)) throw new CardHalfMissing();
    return updated;
  }));
  if (!card) return null;
  syncRecordedCard(kind, deps, sessionId, cardId, card);
  return card;
}

/**
 * **The claim**: the record moves only if it is still in `from` — so of two
 * racing clicks, the loser changes no rows — and the card moves with it in the
 * same transaction. The runner's copy is patched too, or the next turn snapshot
 * (`replaceInProgress`) shows a pending card over a decision already claimed.
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
  return claimDecisionCardWith(kind, deps, sessionId, cardId, from, patch, () => ({}));
}

/**
 * The claim, with the write the decision makes committed in the same transaction: `write` runs
 * first, and what it returns joins the patch. A write that throws, a claim another click won, or
 * a card that has gone rolls both back. The runner is touched only after the commit, so it can
 * never show a decision the database does not hold.
 */
export function claimDecisionCardWith<F extends DecisionCardField, Row extends { sessionId: string }>(
  kind: DecisionCardKind<F>,
  deps: CardClaimDeps<F, Row>,
  sessionId: string,
  cardId: string,
  from: DecisionCardPhase<F>,
  patch: DecisionCardPatch<F>,
  write: () => Partial<DecisionCardOf<F>>,
): DecisionCardOf<F> | null {
  const card = bothHalves(() => deps.records.transaction(() => {
    const written = write();
    if (!deps.records.claimPhase(sessionId, cardId, from, patch.phase, patch.resolvedAt)) {
      throw new CardHalfMissing();
    }
    const updated = deps.chatHistoryManager.updateDecisionCard(kind.field, sessionId, cardId, { ...patch, ...written });
    if (!updated) throw new CardHalfMissing();
    return updated;
  }));
  if (!card) return null;
  syncRecordedCard(kind, deps, sessionId, cardId, card);
  return card;
}

/**
 * The runner half of a transition: the turn's copy and the live emit.
 *
 * The snapshot rewrite is narrower than the patch: `recordedCards` is cleared
 * only when the NEXT turn starts (`resetRunnerTurnState`), so a card resolved
 * after its turn ended is still there to patch, and rebuilding the snapshot then
 * would re-insert the finished turn as in-progress rows.
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
