import { WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";

/**
 * MergeConflictIndicator — surfaces GitHub's `CONFLICTING` mergeable state.
 *
 * Renders a warning-tone label next to the CI indicator when the PR cannot
 * be merged because the base branch has diverged. Only shown when the
 * GitHub poller has explicitly observed `"conflicting"` — `"unknown"` is
 * treated as neutral to avoid flicker after a push (see OpenPhase comment).
 */
export function MergeConflictIndicator() {
  return (
    <span
      className="h-6 text-(--color-warning) text-xs flex items-center gap-1 shrink-0"
      title="Branch has merge conflicts with the base branch. Use Resolve conflicts to rebase and let the agent fix them."
    >
      <WarningIcon size={ICON_SIZE.SM} /> Merge conflicts
    </span>
  );
}
