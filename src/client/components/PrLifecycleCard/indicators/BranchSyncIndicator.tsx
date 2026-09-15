import { WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import type { BranchSyncStatus } from "../../../../server/shared/types/github-types.js";

/**
 * BranchSyncIndicator — says out loud that the branch has not reached GitHub.
 *
 * The same fact disables the merge button, but when managed auto-merge is armed
 * that button is not rendered at all: the PR simply never merged and the only
 * record was one deduplicated `[auto-merge] Holding merge …` line in the
 * orchestrator's stdout. `ahead` is now repaired automatically, so this is
 * mostly the label for a `diverged` branch and for a repair that has not landed
 * yet — either way the user can see why nothing is happening.
 */
export function BranchSyncIndicator({ sync }: { sync: BranchSyncStatus | undefined }) {
  const label = sync?.state === "ahead"
    ? `${sync.ahead} commit${sync.ahead === 1 ? "" : "s"} not on GitHub yet`
    : sync?.state === "diverged"
      ? "Branch has diverged from its remote"
      : null;
  if (!label) return null;

  return (
    <span
      className="h-6 text-(--color-warning) text-xs flex items-center gap-1 shrink-0"
      title={
        sync?.state === "ahead"
          ? "Merging now would ship the branch without these commits. ShipIt pushes them automatically;"
            + " this clears once they reach GitHub."
          : "This session's branch and its remote have both moved on. Merging now would ship the remote's"
            + " history, not this session's work — reconcile the branch first."
      }
    >
      <WarningIcon size={ICON_SIZE.SM} /> {label}
    </span>
  );
}
