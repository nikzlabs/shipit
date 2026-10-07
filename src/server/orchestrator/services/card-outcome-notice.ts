import type { NoticeDelivery } from "../turn-settlement.js";

/**
 * The notice that tells the agent, at the start of its next turn, what the user
 * decided on its cards — for every card kind (docs/324-scheduled-sessions
 * plan.md → Cards: proposals and approvals). It is docs/299-agent-settings-access
 * req 8's settings notice with the settings-specific parts moved into
 * {@link CardOutcomeKind}; settings is the first kind
 * (`settings-outcome-notice.ts`).
 *
 * **Delivery is at-least-once**: reading is not a consume, and the
 * {@link NoticeDelivery} handed back is acknowledged only once the agent has
 * produced a result for the prompt. So a line the agent may see twice must not
 * be the authority for anything: each kind's last line sends the agent to the
 * command that is.
 */

/** What one kind supplies to the notice. */
export interface CardOutcomeKind<Outcome extends { cardId: string }, Deps> {
  /** The tag on this kind's log lines. */
  readonly tag: string;
  /** The resolved cards this session owes the agent, oldest first, WITHOUT marking any. */
  pending(deps: Deps, sessionId: string): Outcome[];
  /** Records that the agent has been told about these cards. */
  markNotified(deps: Deps, sessionId: string, cardIds: readonly string[]): void;
  /** The notice's first line, for one outcome or several. */
  opener(count: number): string;
  /** One bullet per outcome. It carries no text the agent or the user supplied unless it is marked as data. */
  describe(outcome: Outcome): string;
  /** The last line: that this is ShipIt's status line, and what the agent does next. */
  readonly nextStep: string;
}

type CardOutcomeWording<Outcome extends { cardId: string }> = Pick<
  CardOutcomeKind<Outcome, never>,
  "opener" | "describe" | "nextStep"
>;

/**
 * One notice for every outcome of one kind resolved since the last turn. It
 * prefixes the user's message and never starts a turn of its own: a card the
 * user clicked is not a reason to wake an idle session.
 */
export function buildCardOutcomeNotice<Outcome extends { cardId: string }>(
  kind: CardOutcomeWording<Outcome>,
  outcomes: readonly Outcome[],
): string {
  if (outcomes.length === 0) return "";
  return [kind.opener(outcomes.length), ...outcomes.map((o) => kind.describe(o)), kind.nextStep].join("\n");
}

export interface CardOutcomeNotice extends NoticeDelivery {
  readonly notice: string;
  readonly cardIds: readonly string[];
}

/**
 * Read what this session owes the agent for one kind, and hand back the notice
 * plus its receipt. `null` when nothing is owed, so a caller can drop it whole.
 *
 * The latch is set only once the mark has LANDED, so a mark that throws leaves
 * the records pending for the next turn to read afresh.
 */
export function prepareCardOutcomeNotice<Outcome extends { cardId: string }, Deps>(
  kind: CardOutcomeKind<Outcome, Deps>,
  deps: Deps,
  sessionId: string,
): CardOutcomeNotice | null {
  let outcomes: Outcome[];
  try {
    outcomes = kind.pending(deps, sessionId);
  } catch (err) {
    // A turn must never fail to start over a notice. The records stay unmarked,
    // so the next turn tries again.
    console.error(`[${kind.tag}] reading resolved cards for ${sessionId} failed:`, err);
    return null;
  }
  if (outcomes.length === 0) return null;

  const notice = buildCardOutcomeNotice(kind, outcomes);
  const cardIds = outcomes.map((o) => o.cardId);
  let acknowledged = false;
  return {
    notice,
    cardIds,
    delivered() {
      if (acknowledged) return;
      try {
        kind.markNotified(deps, sessionId, cardIds);
        acknowledged = true;
      } catch (err) {
        console.error(`[${kind.tag}] marking ${cardIds.join(", ")} as told failed:`, err);
      }
    },
  };
}
