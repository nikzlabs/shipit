/**
 * "Can this install run a turn?" — one answer for every surface that cares.
 *
 * docs/257 (reqs 3, 8, 10). Two surfaces read this fact and they must never
 * disagree: the composer, which is disabled as a whole and says why while the
 * install cannot run anything (req 3), and the empty-session starter prompts,
 * which are hidden in that state because a chip *seeds* the composer rather
 * than sending — so a chip over a dead input would leave the user holding an
 * unsendable message with the explanation gone (req 10). Both read the same
 * expression from here rather than two expressions that happen to agree today.
 *
 * The fact itself is computed on the server (`services/settings.ts`
 * → `computeCanRunTurns`) and arrives on `GET /api/bootstrap` and every
 * `agent_list` SSE. Nothing in this module re-derives it from `agentList`.
 */

import { useSettingsStore } from "../stores/settings-store.js";
import { useUiStore } from "../stores/ui-store.js";

/**
 * The placeholder a composer shows when the install has no runnable service
 * (req 3). Three properties, all load-bearing:
 *
 * - **It names no location.** The same string serves while the onboarding panel
 *   is on screen (phase 2, where the ask sits directly above the input) and
 *   long after onboarding, when the answer is Settings. "In Settings" is wrong
 *   in the first case; "above" is wrong in the second.
 * - **Its verb and noun match the control to find** — docs/252's Settings
 *   surface is "Services" and its action is "Add a service".
 * - **It says what is blocked, not what is broken.** The composer is the only
 *   disabled thing; everything else works, so this is an instruction.
 */
export const NO_RUNNABLE_SERVICE_REASON = "Add a service to start chatting";

/**
 * The composer's `disabledReason`, or `undefined` when the chat is live.
 *
 * `bootstrapLoaded` is not decoration: the store's pre-bootstrap default is
 * `false`, so without the gate a perfectly runnable install would paint one
 * frame of dead composer telling the user to add a service. Undefined until
 * the server has actually answered.
 */
export function chatDisabledReason(state: {
  bootstrapLoaded: boolean;
  canRunTurns: boolean;
}): string | undefined {
  if (!state.bootstrapLoaded) return undefined;
  return state.canRunTurns ? undefined : NO_RUNNABLE_SERVICE_REASON;
}

/**
 * docs/257 req 10 — whether the empty-session starter prompts
 * (`docs/216-onboarding-starter-prompts`) may render.
 *
 * **Both conditions, deliberately.** They coincide in every normal case — a
 * user who has just finished harness onboarding is runnable by definition — and
 * diverge only where onboarding was completed and every credential was later
 * removed. There the prompts are hidden, for the reason in this module's
 * docstring.
 *
 * This is a gate layered *on top of* whatever eligibility docs/216 defines for
 * itself: it only ever removes prompts and never adds them anywhere. docs/216's
 * re-implementation `&&`s this into its own render condition.
 *
 * `harnessOnboardingCompletedAt` is the install-level historical stamp
 * introduced in phase 2 of docs/257; until it exists on the wire, callers pass
 * what they have and the gate is closed, which is the correct reading of "we
 * have no record that onboarding was completed".
 */
export function starterPromptsAllowed(state: {
  harnessOnboardingCompletedAt: string | null | undefined;
  canRunTurns: boolean;
}): boolean {
  const completed =
    state.harnessOnboardingCompletedAt !== null &&
    state.harnessOnboardingCompletedAt !== undefined;
  return completed && state.canRunTurns;
}

/**
 * docs/257 req 9 — whether the harness-onboarding panel takes the chat pane.
 *
 * **Three clauses, and the middle one is the only one about onboarding itself.**
 *
 * - `bootstrapLoaded`, because the store's pre-bootstrap default is "never
 *   completed" — without it a set-up install paints one frame of setup panel
 *   over its own conversation.
 * - `harnessOnboardingCompletedAt == null` — the historical condition. Not
 *   `!canRunTurns`: a user who completed onboarding and later removed every
 *   credential is not a new user and does not get the panel back (req 9). They
 *   get the disabled composer's placeholder, which says what to do.
 * - `!githubGateUp` — **not decoration.** On a fresh install both onboarding
 *   halves are unfinished at once, so without this clause the panel would mount
 *   *behind* the GitHub gate's backdrop, and a mid-session token loss would
 *   stack the gate over a panel that may itself have the add-service dialog
 *   open. The two are not naturally exclusive; this is what makes them so.
 */
export function harnessOnboardingPanelVisible(state: {
  bootstrapLoaded: boolean;
  harnessOnboardingCompletedAt: string | null;
  githubGateUp: boolean;
}): boolean {
  if (!state.bootstrapLoaded) return false;
  if (state.githubGateUp) return false;
  return state.harnessOnboardingCompletedAt === null;
}

/** Store-reading wrapper for {@link chatDisabledReason} — the composer's hook. */
export function useChatDisabledReason(): string | undefined {
  const canRunTurns = useSettingsStore((s) => s.canRunTurns);
  const bootstrapLoaded = useUiStore((s) => s.bootstrapLoaded);
  return chatDisabledReason({ bootstrapLoaded, canRunTurns });
}

/** Store-reading wrapper for {@link harnessOnboardingPanelVisible}. */
export function useHarnessOnboardingPanelVisible(githubGateUp: boolean): boolean {
  const harnessOnboardingCompletedAt = useSettingsStore((s) => s.harnessOnboardingCompletedAt);
  const bootstrapLoaded = useUiStore((s) => s.bootstrapLoaded);
  return harnessOnboardingPanelVisible({
    bootstrapLoaded,
    harnessOnboardingCompletedAt,
    githubGateUp,
  });
}
