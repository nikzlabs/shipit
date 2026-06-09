/**
 * PrActionsMenu — the reusable PR-scoped overflow (`⋮`) menu.
 *
 * Holds only actions that act on the *pull request / branch*: arm auto-merge,
 * sync the branch onto its base, copy the branch name, and close the PR. It is
 * fully self-contained — everything is derived from `sessionId` + the stores —
 * so it can be dropped, verbatim, into both the inline `PrLifecycleCard` and the
 * detail-panel header (`PrDetailHeader`) and stay in sync.
 *
 * Chat/session-scoped actions (Download chat, Recover recent rewind) deliberately
 * do NOT live here — they belong to the conversation, not the PR, and live in the
 * sidebar's per-session menu instead (see SessionSidebar).
 */

import { ArrowsClockwiseIcon, CopyIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { usePrStore } from "../stores/pr-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { OverflowMenu } from "./ui/overflow-menu.js";
import { DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu.js";
import { AutoFixPauseToggle, AutoMergeToggle, ClosePrDropdownItem, useClosePr } from "./PrStatusControls.js";

export function PrActionsMenu({ sessionId }: { sessionId: string }) {
  const card = usePrStore((s) => s.cardBySession[sessionId]);
  const autoMerge = usePrStore((s) => s.autoMergeBySession[sessionId] ?? s.cardBySession[sessionId]?.autoMerge);
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId));
  const setToast = useUiStore((s) => s.setToast);
  const startRebase = useGitStore((s) => s.startRebase);
  const rebaseStatus = useGitStore((s) => s.rebaseStatus);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));
  // docs/186 — the per-session auto-fix pause only makes sense when the global
  // auto-fix-CI setting is on, so the toggle is gated on it (pausing an
  // already-off loop would be a no-op the user can't reason about).
  const globalAutoFixCi = useSettingsStore((s) => s.autoFixCi);
  const closeState = useClosePr(sessionId);

  // Whether the session has a GitHub remote — gates the remote-only actions
  // (auto-merge, sync). Mirrors the `canAutoMerge` prop the card passes around.
  const canAutoMerge = !!session?.remoteUrl;
  // Prefer card-derived branches because they update mid-turn (e.g. branch
  // rename on graduation), then fall back to the session record.
  const headBranch = card?.pr?.headBranch ?? card?.headBranch ?? session?.branch;
  const syncBaseBranch = card?.pr?.baseBranch ?? "main";
  const syncDisabled = isAgentRunning || rebaseStatus !== "idle";
  const isOpen = card?.phase === "open";

  const handleCopyBranch = () => {
    if (!headBranch) return;
    void navigator.clipboard.writeText(headBranch);
    setToast({ message: "Branch name copied" });
  };

  // "Sync with <base>" rebases the branch onto the latest base and pushes,
  // reusing the conflict-resolution flow that the push-rejected banner and the
  // "Resolve conflicts" button already drive.
  const handleSyncWithBase = () => {
    if (isAgentRunning || useGitStore.getState().rebaseStatus !== "idle") return;
    void startRebase(sessionId, syncBaseBranch);
  };

  // The auto-merge toggle is shown here only for the phases without an inline
  // row (pre-PR, merged, closed); the open phase shows it inline on the card.
  // The trigger is always rendered (the menu is a stable home for PR actions);
  // in practice Copy branch name is essentially always available, so it's never
  // empty for a real session.
  const showAutoMergeToggle = canAutoMerge && !isOpen;
  // Auto-fix pause is relevant whenever the session has a remote and the global
  // auto-fix-CI loop is on — independent of the PR phase (CI runs while open).
  const showAutoFixPause = canAutoMerge && globalAutoFixCi;

  return (
    <OverflowMenu
      label="Pull request actions"
      triggerClassName="h-auto w-auto p-1"
      onOpenChange={(open) => {
        // Reset the destructive close-confirm whenever the menu closes, so a
        // partial confirmation never carries over to the next open.
        if (!open) closeState.reset();
      }}
    >
      {showAutoMergeToggle && (
        <>
          <div className="px-2 py-1">
            <AutoMergeToggle sessionId={sessionId} autoMerge={autoMerge} />
          </div>
          <DropdownMenuSeparator />
        </>
      )}
      {showAutoFixPause && (
        <>
          <div className="px-2 py-1">
            <AutoFixPauseToggle sessionId={sessionId} />
          </div>
          <DropdownMenuSeparator />
        </>
      )}
      {canAutoMerge && (
        <DropdownMenuItem
          onSelect={handleSyncWithBase}
          disabled={syncDisabled}
          title={
            isAgentRunning
              ? "Wait for the agent to finish before syncing"
              : `Rebase onto ${syncBaseBranch} and push`
          }
        >
          <ArrowsClockwiseIcon size={ICON_SIZE.SM} />
          Sync with {syncBaseBranch}
        </DropdownMenuItem>
      )}
      {headBranch && (
        <DropdownMenuItem onSelect={handleCopyBranch} title={`Copy ${headBranch}`}>
          <CopyIcon size={ICON_SIZE.SM} />
          Copy branch name
        </DropdownMenuItem>
      )}
      {isOpen && (
        <>
          <DropdownMenuSeparator />
          <ClosePrDropdownItem state={closeState} />
        </>
      )}
    </OverflowMenu>
  );
}
