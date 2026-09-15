import { renderOwn, type Rendered } from "./settings-catalogue/rendered.js";
import type { SettingsProposalPhase } from "./types/domain-types/chat.js";

/**
 * What a proposal phase means and what the agent does about it
 * (docs/299-agent-settings-access req 8).
 *
 * Here rather than beside either reader because **two** surfaces report a phase
 * and they must not drift: the next-turn notice
 * (`orchestrator/services/settings-outcome-notice.ts`) and the read the notice
 * sends the agent to, `shipit settings get` — where `lastProposal` is the
 * authority for what became of a card. A dismissed proposal the notice named and
 * the read did not render is the defect this table exists to make impossible;
 * `shipit-docs/settings.md` tabulates the same ten phases for the agent.
 *
 * The notice sees only the resolved ones. The read sees all ten, because a card
 * still in front of the user is exactly what stops the agent posting another.
 */
export interface ProposalPhaseGuidance {
  /** How ShipIt names the phase when it reports it. */
  readonly headline: string;
  /** One sentence on what to do next; empty where the phase asks for nothing. */
  readonly guidance: string;
}

export const PROPOSAL_PHASE_GUIDANCE: Record<SettingsProposalPhase, ProposalPhaseGuidance> = {
  pending: {
    headline: "PENDING",
    guidance: "The card is in front of the user. Do nothing, and do not post another for this value.",
  },
  applying: {
    headline: "APPLYING",
    guidance: "The click landed and the write is running. The next read says how it ended.",
  },
  applied: { headline: "APPLIED", guidance: "" },
  dismissed: {
    headline: "DISMISSED by the user",
    guidance: "Do not propose that value again unless they ask.",
  },
  partial: {
    headline: "PARTIALLY applied",
    guidance: "Some of what the card showed did not land — read the value, say what differs, and "
      + "propose the rest.",
  },
  failed: {
    headline: "FAILED",
    guidance: "ShipIt verified that nothing changed; you may propose again, saying so.",
  },
  uncertain: {
    headline: "NOT VERIFIED",
    guidance: "ShipIt cannot say what this change did, or whether it ran at all — read the value,"
      + " and never claim it worked.",
  },
  stale: {
    headline: "NOT applied",
    guidance: "The setting had moved since the card was written; propose again from the current value.",
  },
  refused: {
    headline: "NOT applied",
    guidance: "The change was no longer valid when the user clicked; you may propose again.",
  },
  unknown: {
    headline: "NOT VERIFIED",
    guidance: "ShipIt restarted mid-apply, and never retries one — read the value.",
  },
};

/**
 * The phase's headline, falling back to the STORED string for a phase this build
 * does not know — flattened, because that fallback is the one path here that
 * puts persisted text on a line (`Last proposal: …`, planning#577). The phase is
 * typed as a union and read back from SQLite with a cast, so the type says it is
 * one of ten and the row is whatever a restore or a migration left there.
 */
export function proposalPhaseHeadline(phase: string): Rendered {
  const known = PROPOSAL_PHASE_GUIDANCE[phase as SettingsProposalPhase]?.headline;
  return renderOwn(known ?? phase.toUpperCase());
}

/** The phase's one-sentence instruction, or "" where it asks for nothing. */
export function proposalPhaseGuidance(phase: string): string {
  return PROPOSAL_PHASE_GUIDANCE[phase as SettingsProposalPhase]?.guidance ?? "";
}
