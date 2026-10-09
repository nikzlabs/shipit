import { randomUUID } from "node:crypto";
import type {
  SettingsProposalCard,
  SettingsProposalOperation,
  SettingsProposalPhase,
  SettingsProposalSideChange,
  SettingsProposalTarget,
  SettingsProposalTextChange,
} from "../../shared/types.js";
import { findSetting, settingPath } from "../../shared/settings-catalogue/index.js";
import type { Rendered } from "../../shared/settings-catalogue/index.js";
import { ServiceError } from "./types.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SettingsProposalRow, SettingsProposalStore } from "../settings-proposal-store.js";
import { emitChatCard } from "../chat-card-persistence.js";
import {
  claimDecisionCard,
  loadDecisionCard,
  transitionDecisionCard,
  type CardClaimDeps,
  type DecisionCardKind,
  type DecisionCardPersister,
} from "./card-claim.js";

/**
 * The settings proposal card as a transcript object (docs/299-agent-settings-access
 * req 4): how one is written, and its kind in the shared card claim
 * (`card-claim.ts`), which is the single way its phase ever changes.
 *
 * What proposes a change, and what resolves one, live elsewhere. Both depend on
 * the invariant the claim owns: **a card's durable row and the copy a viewer is
 * looking at never disagree.**
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

export type SettingsProposalPersister = DecisionCardPersister;

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
  /** Both already through the catalogue's formatting door, which is what `Rendered` says. */
  from: Rendered;
  to: Rendered;
  /**
   * Present when the prose outgrew a chip and the card shows a diff instead. Its
   * lines are the raw value rather than `Rendered`: they reach the browser as
   * their own elements, never a line of the agent's text output.
   */
  textChange?: SettingsProposalTextChange;
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
    ...(args.textChange ? { textChange: args.textChange } : {}),
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

export interface SettingsProposalTransition {
  phase: SettingsProposalPhase;
  /** Stamped on any phase that ends the card; omitted for the claim. */
  resolvedAt?: string;
  outcome?: string;
  outcomeDetail?: string;
  effect?: SettingsProposalCard["effect"];
}

/** Settings proposals as the first kind of the shared card claim (`card-claim.ts`). */
export const SETTINGS_PROPOSAL_CARD: DecisionCardKind<"settingsProposal"> = {
  field: "settingsProposal",
  noun: "settings proposal",
  updated: (sessionId, cardId, card) => ({ type: "settings_proposal_update", sessionId, cardId, card }),
};

function claimDeps(deps: SettingsProposalDeps): CardClaimDeps<"settingsProposal", SettingsProposalRow> {
  return {
    chatHistoryManager: deps.chatHistoryManager,
    records: deps.proposals,
    getRunnerRegistry: deps.getRunnerRegistry,
  };
}

/**
 * Every phase change a settings proposal makes outside the claim — a terminal
 * answer, or the boot pass's `unknown` — through the shared transition contract
 * (`transitionDecisionCard`).
 */
export function transitionSettingsProposal(
  deps: SettingsProposalDeps,
  sessionId: string,
  cardId: string,
  transition: SettingsProposalTransition,
): SettingsProposalCard | null {
  return transitionDecisionCard(SETTINGS_PROPOSAL_CARD, claimDeps(deps), sessionId, cardId, {
    phase: transition.phase,
    ...(transition.resolvedAt ? { resolvedAt: transition.resolvedAt } : {}),
    ...(transition.outcome ? { outcome: transition.outcome } : {}),
    ...(transition.outcomeDetail ? { outcomeDetail: transition.outcomeDetail } : {}),
    ...(transition.effect ? { effect: transition.effect } : {}),
  });
}

/**
 * The claim of a settings proposal out of `from`, through the shared claim
 * (`claimDecisionCard`): two clicks racing produce one claim.
 */
export function claimSettingsProposal(
  deps: SettingsProposalDeps,
  sessionId: string,
  cardId: string,
  from: SettingsProposalPhase,
  transition: SettingsProposalTransition,
): SettingsProposalCard | null {
  return claimDecisionCard(SETTINGS_PROPOSAL_CARD, claimDeps(deps), sessionId, cardId, from, {
    phase: transition.phase,
    ...(transition.resolvedAt ? { resolvedAt: transition.resolvedAt } : {}),
    ...(transition.outcome ? { outcome: transition.outcome } : {}),
  });
}

/**
 * The first step of a settings decision: the proposal's private row and its card
 * in this session, or a refusal before anything is written.
 */
export function loadSettingsProposal(
  deps: SettingsProposalDeps,
  sessionId: string,
  cardId: string,
): SettingsProposalRow {
  return loadDecisionCard(SETTINGS_PROPOSAL_CARD, claimDeps(deps), sessionId, cardId).record;
}
