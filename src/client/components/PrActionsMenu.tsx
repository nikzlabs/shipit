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
import { usePrStore, useActiveAutoMerge } from "../stores/pr-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useSessionDefaultBranch } from "../utils/default-branch.js";
import { OverflowMenu } from "./ui/overflow-menu.js";
import { DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu.js";
import { AutoFixPauseToggle, AutoMergeToggle, ClosePrDropdownItem, useClosePr } from "./PrStatusControls.js";

export function PrActionsMenu({ sessionId }: { sessionId: string }) {
  const card = usePrStore((s) => s.cardBySession[sessionId]);
  const autoMerge = useActiveAutoMerge(sessionId);
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId));
  const setToast = useUiStore((s) => s.setToast);
  const startRebase = useGitStore((s) => s.startRebase);
  const resetBranchToBase = useGitStore((s) => s.resetBranchToBase);
  const rebaseStatus = useGitStore((s) => s.rebaseStatus);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));

  const globalAutoFixCi = useSettingsStore((s) => s.autoFixCi);
  const repoDefaultBranch = useSessionDefaultBranch(sessionId);
  const closeState = useClosePr(sessionId);

  const canAutoMerge = !!session?.remoteUrl;
  // Prefer card-derived branches because they update mid-turn (e.g. branch

  const headBranch = card?.pr?.headBranch ?? card?.headBranch ?? session?.branch;

  const syncBaseBranch = card?.pr?.baseBranch ?? repoDefaultBranch;
  const syncDisabled = isAgentRunning || rebaseStatus !== "idle";
  const isOpen = card?.phase === "open";
  const isMerged = card?.phase === "merged";

  const handleCopyBranch = () => {
    if (!headBranch) return;
    void navigator.clipboard.writeText(headBranch);
    setToast({ message: "Branch name copied" });
  };

  const handleSyncWithBase = () => {
    if (isAgentRunning || useGitStore.getState().rebaseStatus !== "idle") return;
    if (isMerged) {
      void resetBranchToBase(sessionId);
    } else {
      void startRebase(sessionId, syncBaseBranch);
    }
  };

  // open). What it must NOT do is show the dead PR's arming — `useActiveAutoMerge`

  // in practice Copy branch name is essentially always available, so it's never

  const showAutoMergeToggle = canAutoMerge && !isOpen;

  const showAutoFixPause = canAutoMerge && globalAutoFixCi;

  return (
    <OverflowMenu
      label="Pull request actions"
      triggerClassName="h-auto w-auto p-1"
      onOpenChange={(open) => {

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
              : isMerged
                ? `Reset to ${syncBaseBranch} and update the branch`
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
