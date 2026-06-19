/**
 * release-confirm-message — the pure builder for the chat message ShipIt injects
 * when the user clicks "Confirm & publish" on a `ReleaseLifecycleCard` (docs/171,
 * docs/214).
 *
 * This message is **card-injected**, not hand-typed. So — mirroring
 * `action-checklist-message.ts` — it leads with an explicit provenance marker
 * (`[Release card → Confirm & publish]`) and frames the body as *intent* ("the
 * user approved publishing this version") rather than a literal command. The
 * agent must treat it as a directive to release THIS version while applying its
 * own judgment about the current repo state, not as a verbatim string to obey.
 *
 * Why the framing matters: the wording is mechanism-aware, and a `release-branch`
 * repo (ShipIt's own — `shipit.yaml` `release.mechanism: release-branch`) is
 * released by merging a version-bump PR into the maintenance branch, with CI
 * deriving the tag on merge. In *steady state* the agent must not push a tag (a
 * hand-pushed tag collides with CI). But during a **cold start** the documented
 * remedy is a one-time tag-path bootstrap — which the card already flags via its
 * auto-publish/cold-start warning. An absolute "never push a tag" string would
 * directly contradict that remedy, so we phrase the safety intent as "let CI tag
 * on merge — but re-check the card's warning first" instead of an absolute. Every
 * other mechanism (`tag-triggered`, the platform default — plus `brokered`/
 * unknown, which fall through to the same wording) is released by the agent
 * pushing the tag itself.
 *
 * Kept as a pure function (no React, no store) so the per-mechanism branching is
 * trivially unit-tested, mirroring `action-checklist-message.ts`.
 */

import type { ReleaseMechanism } from "../../server/shared/types.js";

/**
 * Provenance marker stamped on every variant so the agent can tell a templated
 * card confirmation from a hand-typed instruction and apply judgment instead of
 * obeying the literal string. Mirrors `action-checklist-message.ts`'s
 * `provenanceClause`.
 */
const CARD_MARKER = "[Release card → Confirm & publish]";

/**
 * Build the "yes, ship it" reply for a confirmed release proposal. The card
 * defaults `mechanism` to `tag-triggered` when the server omitted it, so callers
 * always pass a concrete mechanism.
 */
export function buildReleaseConfirmMessage(version: string, mechanism: ReleaseMechanism): string {
  if (mechanism === "release-branch") {
    return (
      `${CARD_MARKER} I approved publishing the ${version} release. This is intent, ` +
      `not a literal command: follow this repo's release-branch mechanism and re-check ` +
      `the current state before acting. Bump the version and open (or merge) the ` +
      `version-bump PR into the release branch, and let CI tag and publish on merge — ` +
      `but FIRST check the card's auto-publish/cold-start warning, and if a merge ` +
      `won't actually tag yet, adapt per the documented one-time bootstrap rather than ` +
      `assuming the merge alone ships it.`
    );
  }
  return (
    `${CARD_MARKER} I approved publishing the ${version} release. This is intent, not a ` +
    `literal command: follow this repo's release mechanism and re-check the current ` +
    `state before acting. Bump the version, commit, create the annotated tag, and push ` +
    `the tag.`
  );
}
