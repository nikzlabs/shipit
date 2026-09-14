import { randomUUID } from "node:crypto";
import type {
  SettingsProposalCard,
  SettingsProposalPhase,
  SettingsProposalTarget,
} from "../../shared/types.js";
import type { AnySettingDeclaration } from "../../shared/settings-catalogue/index.js";
import { settingPath } from "../../shared/settings-catalogue/index.js";
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
  getSettingsProposalCard(sessionId: string, cardId: string): SettingsProposalCard | undefined;
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
  declaration: Pick<AnySettingDeclaration, "key" | "label" | "description" | "tab">;
  target: SettingsProposalTarget;
  /** Both already through the catalogue's formatting door. */
  from: string;
  to: string;
  /** The projected current value and the value to write, for the private row. */
  fromValue: unknown;
  proposedValue: unknown;
  reason?: string | undefined;
}

/**
 * Write a proposal: the private row first, then the card.
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
  deps: SettingsProposalDeps,
  runner: ProposalRunner,
  args: PostSettingsProposalArgs,
): SettingsProposalCard {
  const { sessionId, declaration } = args;
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
    ...(reason ? { reason } : {}),
    phase: "pending",
    createdAt,
  };

  deps.proposals.create({
    cardId: card.cardId,
    sessionId,
    target: args.target,
    phase: "pending",
    from: args.fromValue,
    proposed: args.proposedValue,
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
 *  1. the durable row and the private row, **unconditionally** — this is what
 *     the next decision, the next read and the next boot see;
 *  2. only then, and only if a runner exists, the copy the turn is holding plus
 *     the live emit.
 *
 * A database-only write can still be undone by the next turn snapshot rebuilding
 * the in-progress rows from `recordedCards` — which is why step 2 patches them
 * rather than leaving the rebuild to reproduce a stale card. Where there is no
 * runner at all there is nothing to rebuild from, so the durable row stands.
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

  const card = deps.chatHistoryManager.updateSettingsProposalCard(sessionId, cardId, patch);
  deps.proposals.setPhase(cardId, transition.phase, transition.resolvedAt);
  if (!card) return null;

  const runner = deps.getRunnerRegistry()?.get(sessionId);
  if (!runner) return card;

  const patched = updateRecordedCard(
    runner,
    (m) => m.settingsProposal?.cardId === cardId,
    (m) => ({ ...m, settingsProposal: card }),
  );
  if (patched) {
    persistTurnInProgress(deps.chatHistoryManager, runner, sessionId);
    if (typeof runner.getTurnEventBuffer === "function") {
      runner.lastPersistedBufferIndex = runner.getTurnEventBuffer().length;
    }
  }
  runner.emitMessage({ type: "settings_proposal_update", sessionId, cardId, card });
  return card;
}
