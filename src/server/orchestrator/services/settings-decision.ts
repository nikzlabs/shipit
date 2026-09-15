import { findSetting } from "../../shared/settings-catalogue/index.js";
import type { AnySettingDeclaration, ApplyOutcome } from "../../shared/settings-catalogue/index.js";
import type {
  SettingsProposalCard,
  SettingsProposalPhase,
  SettingsProposalSideChange,
} from "../../shared/types.js";
import type { SettingsProposalRow, SettingsProposalStore } from "../settings-proposal-store.js";
import { baselineMatches, settingBaseline } from "./settings-baseline.js";
import type { SettingBaseline, SettingBaselineDeps } from "./settings-baseline.js";
import { withConflictDomains } from "./settings-conflict-domain.js";
import { appliedOutcome, findOperation } from "./settings-operations.js";
import type { SettingsOperation, SettingsOperationDeps } from "./settings-operations.js";
import { getSettingForAgent } from "./settings-read.js";
import type { SettingDetailEntry, SettingsReadDeps } from "./settings-read.js";
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
 * What the setting says about itself once the write has run: whether the stored
 * value is the one ShipIt would now use (plan.md → Saved is not effective), and
 * whether it is the one the card promised.
 *
 * ONE read answers both, through the agent's own read surface rather than
 * re-derived, so the card and `shipit settings get` cannot disagree about the
 * same setting. A failure here costs the card those two lines and nothing else:
 * the write already happened.
 */
interface AfterApply {
  effect?: SettingsProposalCard["effect"];
  /** Present when the store does not hold what the card named. */
  mismatch?: string;
}

async function verifyAfterApply(
  deps: SettingsDecisionDeps,
  sessionId: string,
  declaration: AnySettingDeclaration,
  row: SettingsProposalRow,
  card: SettingsProposalCard,
): Promise<AfterApply> {
  try {
    const entry = await getSettingForAgent(deps.read, sessionId, declaration.key);
    const effect = entry.effect.state === "live" ? undefined : entry.effect;
    const mismatch = storedValueMismatch(declaration, row, card, entry);
    return { ...(effect ? { effect } : {}), ...(mismatch ? { mismatch } : {}) };
  } catch (err) {
    console.error(`[settings-decision] reading ${declaration.key} back after applying failed:`, err);
    return {};
  }
}

/**
 * The card promised a value; this is what the store now holds instead, or null
 * when the two agree (docs/299-agent-settings-access req 4).
 *
 * The prospective defences come first and catch more: a declared type answers
 * with the value the store will hold (`value-types.ts`), a projection that
 * would not emit the value refuses the card, and an operation that writes more
 * than its own field declares it as `alsoChanges`. None of them can see what a
 * SAVE HOOK does after the write — seeding a replacement, deriving a
 * neighbour — so the last word is the store's own, read back.
 *
 * **Not seeing a value is never evidence about the write**, which is the whole
 * shape of this check: every branch that cannot compare answers `null` rather
 * than reporting a failure it did not observe. Only a `set` is compared — a
 * membership card displays ShipIt's own wording rather than a value ("on the
 * global allowlist"), and those writers already answer from the resulting
 * membership, `applyEgressHostRemove` reporting `failed` for a host still on
 * the list.
 */
export function storedValueMismatch(
  declaration: AnySettingDeclaration,
  row: Pick<SettingsProposalRow, "operation" | "target" | "proposed">,
  card: SettingsProposalCard,
  entry: SettingDetailEntry,
): string | null {
  if (row.operation !== "set") return null;
  // Unreadable is the read's own answer about the setting, not a claim about
  // this write, and `effect` is where the card already says so.
  if (!entry.readable) return null;

  const item = row.target.item;
  const stored = item ? entry.items?.find((candidate) => candidate.address === item) : entry;
  // An instance leaves the read for reasons that are nothing to do with this
  // write: a rename moves the address the card was written against, and a
  // service/mode setting stops being listed the moment its last credential
  // goes (`settings-store-readers.ts` → `modePairs`). Both are writes that
  // landed, and reporting them would be the check inventing its own defect.
  if (!stored) return null;

  if (card.textChange) {
    // The card's `to` is ShipIt's SUMMARY of the prose — two sizes and a
    // `+n −n` — so comparing what the card displays would pass any rewrite of
    // the same length. What the click promised is the approved TEXT.
    const approved = typeof row.proposed === "string" ? row.proposed : "";
    const now = typeof stored.value === "string" ? stored.value : "";
    // Neither side is quoted back: a prose card keeps the value out of the
    // scrollback on purpose (req 9), and this line lands in the same place.
    return now === approved
      ? null
      : `${declaration.key} does not now hold the text this card showed.`;
  }
  if (stored.display === card.to) return null;
  return `The card showed ${card.to}, and ${declaration.key} now reads ${stored.display}.`;
}

/** One comparable line per side change, in the operation's own order. */
function describeSideChanges(changes: SettingsProposalSideChange[]): string {
  return changes.map((change) => `${change.label} ${change.from} → ${change.to}`).join("; ");
}

async function runApply(
  deps: SettingsDecisionDeps,
  sessionId: string,
  row: SettingsProposalRow,
  card: SettingsProposalCard,
  declaration: AnySettingDeclaration,
  operation: SettingsOperation,
): Promise<Terminal> {
  // The card froze its repository when it was written, and the session can have
  // been rebound since. The permission belongs to the repository the user was
  // looking at, so a card for another one is refused rather than applied to a
  // repository nobody asked about (plan.md → The target, and the lock).
  const bound = deps.read.sessionManager.get(sessionId)?.remoteUrl || null;
  if (row.target.repoUrl && row.target.repoUrl !== bound) {
    const nowBinds = bound ? `now binds ${bound}` : "no longer binds a repository";
    return {
      phase: "refused",
      outcome: `This card is about ${row.target.repoUrl}, and this session ${nowBinds}.`,
    };
  }

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
    // The side changes are re-derived and compared with the CARD, because they
    // are computed from live state the baseline does not cover — which harnesses
    // are installed, which levels a selection offers. A card that would now
    // write something it never displayed is refused rather than applied: the
    // user approved what the card said (plan.md → The unit of a change is the
    // declared operation).
    const derived = operation.alsoChanges?.(deps.operations, row.target, row.proposed) ?? [];
    const shown = card.alsoChanges ?? [];
    if (describeSideChanges(derived) !== describeSideChanges(shown)) {
      return {
        phase: "refused",
        outcome: "Applying this now would write something this card does not show, so nothing was written.",
        outcomeDetail: `The card says: ${describeSideChanges(shown) || "nothing else changes"}. `
          + `It would now also do: ${describeSideChanges(derived) || "nothing else"}.`,
      };
    }
    const outcome = await operation.apply(deps.operations, row.target, row.proposed);
    const phase = OUTCOME_PHASE[outcome.status];
    const verified = phase === "failed"
      ? {}
      : await verifyAfterApply(deps, sessionId, declaration, row, card);
    // Only an `applied` is overridden. A writer reporting `partial` or
    // `uncertain` already knows more about what it left behind than a read of
    // the resulting value does.
    if (outcome.status === "applied" && verified.mismatch) {
      return {
        phase: "partial",
        outcome: `${declaration.label} was saved, and it is not what this card showed.`,
        outcomeDetail: verified.mismatch,
        ...(verified.effect ? { effect: verified.effect } : {}),
      };
    }
    return {
      phase,
      outcome: outcome.status === "applied"
        ? appliedOutcome(operation, row.target, card, declaration)
        : undefined,
      ...(outcome.detail ? { outcomeDetail: outcome.detail } : {}),
      ...(verified.effect ? { effect: verified.effect } : {}),
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
    // could not. Nothing ran, so the card says so rather than claiming a write —
    // and it is claimed out of `pending` like any other transition, so a card
    // that already applied or was dismissed keeps the outcome it has.
    const refused = claimSettingsProposal(deps, sessionId, cardId, "pending", {
      phase: "refused",
      resolvedAt: now(),
      outcome: `ShipIt can no longer apply a change to ${declaration.key} from a card.`,
    });
    return { card: refused ?? currentCard(deps, sessionId, cardId), acted: refused !== null };
  }

  const claimed = claimSettingsProposal(deps, sessionId, cardId, "pending", { phase: "applying" });
  if (!claimed) return { card: currentCard(deps, sessionId, cardId), acted: false };

  const terminal = await withConflictDomains(
    operation.domains(row.target, deps.operations, row.proposed),
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
