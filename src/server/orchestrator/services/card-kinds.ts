import type { DecisionCardField } from "../chat-history.js";
import type { ScheduleProposalStore } from "../schedule-proposal-store.js";
import type { SettingsProposalStore } from "../settings-proposal-store.js";
import type { CardOutcomeNotice } from "./card-outcome-notice.js";
import { prepareScheduleOutcomeNotice } from "./schedule-outcome-notice.js";
import {
  prepareSettingsOutcomeNotice,
  type SettingsOutcomeNoticeDeps,
} from "./settings-outcome-notice.js";

/**
 * The cards a user decides on, by kind (docs/324-scheduled-sessions plan.md →
 * Cards: proposals and approvals), and where a turn collects their outcome
 * notices. Keyed by transcript field, so a card field added to the chat history
 * does not compile until its notice is registered here.
 */

/** The stores the kinds read their records from. A store this install lacks owes no notice. */
export interface CardKindStores {
  chatHistoryManager: SettingsOutcomeNoticeDeps["chatHistoryManager"];
  settingsProposals?: SettingsProposalStore | undefined;
  scheduleProposals?: ScheduleProposalStore | undefined;
}

const OUTCOME_NOTICES: Readonly<
  Record<DecisionCardField, (stores: CardKindStores, sessionId: string) => CardOutcomeNotice | null>
> = {
  settingsProposal: (stores, sessionId) =>
    stores.settingsProposals
      ? prepareSettingsOutcomeNotice(
          { proposals: stores.settingsProposals, chatHistoryManager: stores.chatHistoryManager },
          sessionId,
        )
      : null,
  scheduleProposal: (stores, sessionId) =>
    stores.scheduleProposals
      ? prepareScheduleOutcomeNotice({ proposals: stores.scheduleProposals }, sessionId)
      : null,
};

/** Every kind's notice this session owes the agent, in registration order; each is read, never consumed. */
export function prepareCardOutcomeNotices(stores: CardKindStores, sessionId: string): CardOutcomeNotice[] {
  return Object.values(OUTCOME_NOTICES).flatMap((prepare) => prepare(stores, sessionId) ?? []);
}
