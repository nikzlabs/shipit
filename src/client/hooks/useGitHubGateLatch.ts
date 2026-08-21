import { useRef, useState } from "react";

/**
 * docs/257 — whether the blocking GitHub gate is on screen, and how it closes.
 *
 * **The latch is the whole point of this hook, and it is deliberate rather than
 * defensive.** `showGitHubGate` is `triggered && !dismissed`, not `githubNeeded`,
 * and the difference shows up in exactly one situation:
 *
 * | Situation | With the latch | A direct `githubNeeded` gate |
 * |---|---|---|
 * | Established user, fresh load, token already invalid | gate shows | same |
 * | Token expires *during* a load, never dismissed this load | gate shows | same |
 * | User connected GitHub *in this load*, then the token dies | nothing | gate pops over their work |
 *
 * Only the last row differs, and it is the row the human's ruling protects:
 * GitHub keeps **today's** behaviour, and today's behaviour includes not
 * re-gating a user mid-work after they have already been through it. docs/257
 * removes the harness half from this gate; it changes nothing about this.
 *
 * Extracted from `App.tsx` so that property has a test of its own. It is four
 * lines that read like an accident, which is precisely how a later
 * simplification deletes it.
 */
export function useGitHubGateLatch(githubNeeded: boolean): {
  showGitHubGate: boolean;
  /** Close the gate. Called when GitHub connects — there is no other exit. */
  dismiss: () => void;
} {
  const triggeredRef = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  if (githubNeeded && !triggeredRef.current) {
    triggeredRef.current = true;
  }
  return {
    showGitHubGate: triggeredRef.current && !dismissed,
    dismiss: () => setDismissed(true),
  };
}
