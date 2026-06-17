/**
 * release-confirm-message — the pure builder for the chat message ShipIt injects
 * when the user clicks "Confirm & publish" on a `ReleaseLifecycleCard` (docs/171,
 * docs/214).
 *
 * The wording is **mechanism-aware**. A `release-branch` repo (ShipIt's own —
 * `shipit.yaml` `release.mechanism: release-branch`) is released by merging a
 * version-bump PR into the maintenance branch; the repo's CI derives the tag and
 * publishes on merge, so the agent must NEVER create or push a tag — a
 * hand-pushed tag collides with CI and breaks publish. Every other mechanism
 * (`tag-triggered`, the platform default — plus `brokered`/unknown, which fall
 * through to the same wording) is released by the agent pushing the tag itself.
 *
 * Kept as a pure function (no React, no store) so the per-mechanism branching is
 * trivially unit-tested, mirroring `action-checklist-message.ts`.
 */

import type { ReleaseMechanism } from "../../server/shared/types.js";

/**
 * Build the "yes, ship it" reply for a confirmed release proposal. The card
 * defaults `mechanism` to `tag-triggered` when the server omitted it, so callers
 * always pass a concrete mechanism.
 */
export function buildReleaseConfirmMessage(version: string, mechanism: ReleaseMechanism): string {
  if (mechanism === "release-branch") {
    return (
      `Yes — confirm and publish the ${version} release: bump the version and open ` +
      `(or merge) the version-bump PR into the release branch. Do NOT create or push ` +
      `a tag — CI tags and publishes on merge.`
    );
  }
  return (
    `Yes — confirm and publish the ${version} release: bump the version, commit, ` +
    `create the annotated tag, and push the tag.`
  );
}
