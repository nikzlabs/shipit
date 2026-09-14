import { findSetting } from "../../shared/settings-catalogue/index.js";
import type { AnySettingDeclaration, ApplyOutcome } from "../../shared/settings-catalogue/index.js";
import type { SettingsProposalCard, SettingsProposalPhase } from "../../shared/types.js";
import type { SettingsProposalRow, SettingsProposalStore } from "../settings-proposal-store.js";
import { baselineMatches, settingBaseline } from "./settings-baseline.js";
import type { SettingBaseline, SettingBaselineDeps } from "./settings-baseline.js";
import { withConflictDomains } from "./settings-conflict-domain.js";
import { findOperation } from "./settings-operations.js";
import type { SettingsOperation, SettingsOperationDeps } from "./settings-operations.js";
import { getSettingForAgent } from "./settings-read.js";
import type { SettingsReadDeps } from "./settings-read.js";
import { baselineTargetOf } from "./settings-propose.js";
import { claimSettingsProposal, transitionSettingsProposal } from "./settings-proposal.js";
import type { SettingsProposalDeps, SettingsProposalPersister } from "./settings-proposal.js";
import { getErrorMessage } from "../validation.js";
import { ServiceError } from "./types.js";

/**
 * What the user's click does (docs/299-agent-settings-access req 4, plan.md →
 * Applying).
 *
 * The card is the source of truth for what is applied, never the message: a
 * decision supplies a session, a card id and an action, and everything acted on
 * — the setting, the address, the value, the baseline — is loaded from the
 * private proposal row.
 *
 * **Dismiss is its own short path**: load, then one atomic `pending →
 * dismissed`. No lock, no re-read, no revalidation, because declining cannot
 * become stale and cannot fail validation whatever the setting is now. Its
 * durable write can still fail, like any other.
 *
 * **Apply** is claim, then lock, then check, then write, in that order:
 *
 *  1. claim `pending → applying` atomically, so two clicks produce one apply;
 *  2. take the target's conflict domains and hold them across everything below —
 *     a baseline checked outside the lock is a check a dialog save can land
 *     between, which is the overwrite the baseline exists to prevent;
 *  3. re-read the baseline over the WHOLE stored value and compare. Projections
 *     drop fields, so two stored configurations can share the `from` the card
 *     displays, and a target that changed only in a dropped field would compare
 *     equal and be overwritten;
 *  4. revalidate, because a card outlives its turn;
 *  5. apply through the shared layer, and write the terminal phase.
 *
 * **Settlement needs no runner.** A card is clicked hours after its turn as
 * often as during one, and the post-turn lease is 120 s — so every phase change
 * here goes through the transition contract, which writes the durable row
 * whether or not a runner exists.
 */

export type SettingsDecisionAction = "apply" | "dismiss";

export interface SettingsDecisionDeps extends SettingsProposalDeps {
  proposals: SettingsProposalStore;
  chatHistoryManager: SettingsProposalPersister & {
    getSettingsProposalCard(sessionId: string, cardId: string): SettingsProposalCard | undefined;
  };
  read: SettingsReadDeps;
  baseline: SettingBaselineDeps;
  operations: SettingsOperationDeps;
}

export interface SettingsDecisionResult {
  card: SettingsProposalCard;
  /** False when the click found nothing to do: already resolved, or already claimed. */
  acted: boolean;
}

function loadRow(
  deps: SettingsDecisionDeps,
  sessionId: string,
  cardId: string,
): SettingsProposalRow {
  const row = deps.proposals.get(cardId);
  // Session-scoped: a card id names a row in one session's transcript, so a
  // decision arriving under another session must not reach it.
  if (row?.sessionId !== sessionId) {
    throw new ServiceError(404, "That settings proposal is not in this session.");
  }
  return row;
}

function declarationOf(row: SettingsProposalRow): AnySettingDeclaration {
  const declaration = findSetting(row.target.key);
  if (!declaration) {
    throw new ServiceError(400, `ShipIt no longer has a setting called "${row.target.key}".`);
  }
  return declaration;
}

/** The stored revision the card was written against, as the row kept it. */
function storedBaseline(row: SettingsProposalRow): SettingBaseline | null {
  const baseline = row.baseline as SettingBaseline | undefined;
  return baseline?.kind === "revision" ? baseline : null;
}

interface Terminal {
  phase: SettingsProposalPhase;
  outcome?: string;
  outcomeDetail?: string;
  effect?: SettingsProposalCard["effect"];
}

const OUTCOME_PHASE: Record<ApplyOutcome["status"], SettingsProposalPhase> = {
  applied: "applied",
  partial: "partial",
  failed: "failed",
  uncertain: "uncertain",
};

/**
 * Whether the stored value ShipIt would now use is the one the user approved
 * against — and, where it is not, what the read already computes about why
 * (plan.md → Saved is not effective).
 *
 * Read through the agent's own read surface rather than re-derived, so the card
 * and `shipit settings get` cannot disagree about the same setting. A failure
 * here costs the card its effect line and nothing else: the write already
 * happened.
 */
async function effectAfterApply(
  deps: SettingsDecisionDeps,
  sessionId: string,
  key: string,
): Promise<SettingsProposalCard["effect"] | undefined> {
  try {
    const entry = await getSettingForAgent(deps.read, sessionId, key);
    return entry.effect.state === "live" ? undefined : entry.effect;
  } catch (err) {
    console.error(`[settings-decision] reading ${key}'s effect after applying failed:`, err);
    return undefined;
  }
}

async function runApply(
  deps: SettingsDecisionDeps,
  sessionId: string,
  row: SettingsProposalRow,
  card: SettingsProposalCard,
  declaration: AnySettingDeclaration,
  operation: SettingsOperation,
): Promise<Terminal> {
  const approved = storedBaseline(row);
  if (!approved) {
    return {
      phase: "stale",
      outcome: "ShipIt has no record of what this setting was when the card was written",
    };
  }
  const current = await settingBaseline(deps.baseline, baselineTargetOf(declaration, row.target));
  if (!baselineMatches(current, approved)) {
    return { phase: "stale" };
  }

  const refusal = operation.preflight?.(deps.operations, row.target, row.proposed);
  if (refusal) return { phase: "refused", outcome: refusal };
  if (row.operation === "set") {
    const checked = declaration.type.validate(row.proposed, declaration.label);
    if (!checked.ok) return { phase: "refused", outcome: checked.message };
  }

  try {
    const outcome = await operation.apply(deps.operations, row.target, row.proposed);
    const phase = OUTCOME_PHASE[outcome.status];
    const effect = phase === "failed"
      ? undefined
      : await effectAfterApply(deps, sessionId, declaration.key);
    return {
      phase,
      outcome: outcome.status === "applied"
        ? operation.applied(row.target, card.to, declaration)
        : undefined,
      ...(outcome.detail ? { outcomeDetail: outcome.detail } : {}),
      ...(effect ? { effect } : {}),
    };
  } catch (err) {
    // A refused write changed nothing on purpose — an unknown repository, a
    // model that left the catalogue, an eleventh MCP server — so it is the
    // card's `refused`, not a failure. Anything else is a writer that threw
    // where it could not say what it left behind.
    if (err instanceof ServiceError) return { phase: "refused", outcome: err.message };
    console.error(`[settings-decision] applying ${declaration.key} failed:`, err);
    return { phase: "uncertain", outcomeDetail: getErrorMessage(err) };
  }
}

export async function resolveSettingsProposal(
  deps: SettingsDecisionDeps,
  sessionId: string,
  cardId: string,
  action: SettingsDecisionAction,
): Promise<SettingsDecisionResult> {
  const row = loadRow(deps, sessionId, cardId);
  const now = () => new Date().toISOString();

  if (action === "dismiss") {
    const card = claimSettingsProposal(deps, sessionId, cardId, "pending", {
      phase: "dismissed",
      resolvedAt: now(),
    });
    return card ? { card, acted: true } : { card: currentCard(deps, sessionId, cardId), acted: false };
  }

  const declaration = declarationOf(row);
  const operation = findOperation(declaration, row.operation);
  if (!operation) {
    // A card written when ShipIt could apply this change, clicked after it
    // could not. Nothing ran, so the card says so rather than claiming a write.
    const refused = transitionSettingsProposal(deps, sessionId, cardId, {
      phase: "refused",
      resolvedAt: now(),
      outcome: `ShipIt can no longer apply a change to ${declaration.key} from a card.`,
    });
    return { card: refused ?? currentCard(deps, sessionId, cardId), acted: false };
  }

  const claimed = claimSettingsProposal(deps, sessionId, cardId, "pending", { phase: "applying" });
  if (!claimed) return { card: currentCard(deps, sessionId, cardId), acted: false };

  const terminal = await withConflictDomains(
    operation.domains(row.target),
    () => runApply(deps, sessionId, row, claimed, declaration, operation),
  ).catch((err: unknown) => {
    console.error(`[settings-decision] applying ${declaration.key} failed outside the write:`, err);
    return {
      phase: "uncertain" as const,
      outcomeDetail: "ShipIt could not complete this change. The failure is in the server log.",
    };
  });

  const card = transitionSettingsProposal(deps, sessionId, cardId, {
    ...terminal,
    resolvedAt: now(),
  });
  return { card: card ?? claimed, acted: true };
}

/** The card as it stands, for a click that found nothing to do. */
function currentCard(
  deps: SettingsDecisionDeps,
  sessionId: string,
  cardId: string,
): SettingsProposalCard {
  const card = deps.chatHistoryManager.getSettingsProposalCard(sessionId, cardId);
  if (!card) throw new ServiceError(404, "That settings proposal is not in this session.");
  return card;
}

/**
 * Every card found mid-apply at boot, converted before any decision is accepted
 * (plan.md → Applying).
 *
 * It is **never retried**: ShipIt cannot know which side of the write it stopped
 * on, and the side effect may already have run. `unknown` says exactly that, and
 * the card tells the user to check the setting. Converting them BEFORE the
 * decision handler exists is what stops a card being actionable and mid-apply at
 * once — a second click on a card whose first apply is unaccounted for.
 */
export function recoverInterruptedProposals(deps: SettingsProposalDeps): number {
  const interrupted = deps.proposals.listByPhase("applying");
  let converted = 0;
  for (const row of interrupted) {
    try {
      transitionSettingsProposal(deps, row.sessionId, row.cardId, {
        phase: "unknown",
        resolvedAt: new Date().toISOString(),
      });
      converted++;
    } catch (err) {
      console.error(`[settings-decision] could not resolve interrupted proposal ${row.cardId}:`, err);
    }
  }
  if (converted > 0) {
    console.log(`[settings-decision] ${converted} settings proposal(s) were mid-apply at restart`);
  }
  return converted;
}
