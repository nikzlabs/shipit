/**
 * What a credential's stored state means to the surfaces that render it — the
 * word it says when it needs attention, and whether it is a credential at all
 * yet.
 *
 * Both predicates live here, outside any one component, because Settings and
 * the header usage pill each read them and neither owns the other: two copies
 * of these rules would be two ways to describe one broken account.
 */

import type { CredentialRoute } from "../../server/shared/types.js";

/** The word, and the colour it is said in, for a credential that needs attention. */
export interface CredentialStatusWord {
  text: string;
  tone: "warning" | "error";
}

/**
 * The one word a credential says about itself — and only when something needs
 * doing (docs/252 req 19).
 *
 * A ready credential returns `undefined` and its surface stays silent, which is
 * the whole rule: Settings used to print a `status` pill on every row, so the
 * normal case spent width saying "ready" and the abnormal one said "auth
 * failed" in the same grey. The states that need attention now say so in words
 * and in a colour, rather than in a hue alone.
 *
 * planning#358 — the remedy differs by how the credential was supplied, and the
 * word has to name the one that exists. "Reconnect" is an account's remedy:
 * there is a login to run again. A `via: "string"` row is a secret someone
 * pasted or an env var the install was given — there is nothing to reconnect
 * to, and the only fix is a new value. Before 358 a string row could not reach
 * this state at all, so the account wording was the only wording needed; now
 * that a refused supplied secret is recorded, telling its owner to "reconnect"
 * would send them looking for a button that is not there.
 *
 * Shared by the Settings credential row and the header usage pill deliberately:
 * both are read-outs of the same credential, and two copies of this table would
 * be two ways to describe one broken account.
 */
export function credentialStatusWord(
  credential: Pick<CredentialRoute, "status" | "via">,
): CredentialStatusWord | undefined {
  if (credential.status === "ready") return undefined;
  if (credential.status === "authenticating") return { text: "signing in…", tone: "warning" };
  if (credential.via === "string") return { text: "credential rejected", tone: "error" };
  return { text: "reconnect needed", tone: "error" };
}

/**
 * **A row that has never been anything but an attempt is not a credential.**
 *
 * A sign-in needs a row to hang on, so `POST /api/provider-accounts` creates one
 * the instant the user presses *Sign in* — long before anything is connected,
 * and it is deleted again if they leave the flow. Anything that lists
 * credentials must therefore ask whether this row is one yet, or the Services
 * panel gains a card the moment a sign-in starts and loses it the moment the
 * user backs out: two flickers around a card that was never real.
 *
 * **Both clauses are load-bearing, and each covers the other's hole.**
 *
 * - `externalId` is the server's own test for "created by the click, nothing in
 *   it" (`refuseDuplicateConnect`, `provider-account-manager.ts:681`) — it is
 *   written when a completed sign-in reports an identity. On its own it would
 *   over-hide: an unreadable identity **proceeds** by design
 *   (`provider-account-identity.ts:118`), so a genuinely connected account can
 *   lack one.
 * - The two pre-connect statuses cover that: whatever the identity did,
 *   `ready` and `auth_failed` are states only a real login attempt reaches, and
 *   a card must show them. On its own the status would over-hide too, because
 *   `signOutAccount` puts a *connected* row back to `unavailable`.
 *
 * **And hiding can never strand a row**, which is what makes the residual case
 * (connected, no identity reported, then signed out) safe rather than
 * merely unlikely: `AddServiceDialog` **adopts** an existing attempt instead of
 * creating a second, so anything hidden here is picked up by the next sign-in
 * and ends as either a credential or a deletion. Nothing hidden is unreachable.
 */
export function isUnconnectedAttempt(account: CredentialRoute): boolean {
  return account.via === "account"
    && account.externalId === undefined
    && (account.status === "unavailable" || account.status === "authenticating");
}
