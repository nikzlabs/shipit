import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import {
  TrashIcon,
  ArrowCounterClockwiseIcon,
  CheckCircleIcon,
  MinusCircleIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

/**
 * Confirmation dialog for removing a repository (docs/059).
 *
 * Repo removal is more consequential than the old two-click idiom let on: the
 * backend now archives every session for the repo and reclaims their disk
 * (working copies, containers, compose volumes, logs) — see services/session.ts
 * `archiveSession` invoked from the DELETE /api/repos/:url handler. The only
 * unrecoverable loss is uncommitted/unpushed work; everything else (history,
 * pushed branches) survives and the sessions come back archived on re-add. A
 * plain "click again to confirm" can't convey that, so we spell it out here.
 */
export function RemoveRepoDialog({
  open,
  repoName,
  sessionCount,
  onConfirm,
  onClose,
}: {
  open: boolean;
  repoName: string;
  /** Number of visible (non-archived) sessions that will be archived. */
  sessionCount: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const sessionLabel =
    sessionCount === 0
      ? "It has no open sessions."
      : sessionCount === 1
        ? "Its 1 session will be archived and hidden from the sidebar."
        : `Its ${sessionCount} sessions will be archived and hidden from the sidebar.`;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="w-full md:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrashIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-error)" />
            Remove {repoName}?
          </DialogTitle>
        </DialogHeader>

        <div className="px-5 py-4 flex flex-col gap-4">
          <DialogDescription>
            {sessionLabel} Nothing on GitHub is changed.
          </DialogDescription>

          {/* What's freed (deleted from this workspace) */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
              <MinusCircleIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-error)" />
              Freed from this workspace
            </div>
            <ul className="ml-5 list-disc text-sm text-(--color-text-secondary) flex flex-col gap-0.5 marker:text-(--color-text-tertiary)">
              <li>Each session&apos;s working copy, including any <strong className="font-medium text-(--color-text-primary)">uncommitted changes that were never pushed</strong></li>
              <li>Cached dependencies and any running containers</li>
            </ul>
          </div>

          {/* What's kept */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
              <CheckCircleIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-success)" />
              Kept
            </div>
            <ul className="ml-5 list-disc text-sm text-(--color-text-secondary) flex flex-col gap-0.5 marker:text-(--color-text-tertiary)">
              <li>Session chat history, usage, and PR status</li>
              <li>Branches and pull requests you already pushed to GitHub</li>
            </ul>
          </div>

          {/* Re-add reassurance */}
          <div className="flex items-start gap-2 rounded-md bg-(--color-bg-tertiary) px-3 py-2.5 text-sm text-(--color-text-secondary)">
            <ArrowCounterClockwiseIcon size={ICON_SIZE.SM} className="shrink-0 mt-0.5 text-(--color-text-tertiary)" />
            <span>
              Add this repository again later and its sessions reappear under{" "}
              <strong className="font-medium text-(--color-text-primary)">All Sessions</strong>, ready to restore — history and all. Restoring re-clones a fresh working copy, so only unpushed changes stay lost.
            </span>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Remove repository
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
