/**
 * SendReviewDialog — the confirmation step between "Send comments" and the
 * review actually reaching the agent (docs/260).
 *
 * It exists for one thing the review surface has nowhere to put: feedback that
 * belongs to no single line — an overall summary, a constraint, why the review
 * is happening. That goes in the note, and the note becomes the first piece of
 * feedback in the constructed prompt.
 *
 * Deliberately thin: the count and the target, one optional field, Cancel/Send.
 * It does NOT list the comments — the user reads those in the file behind it —
 * and there is no way to drop a comment from here (requirements.md → Later
 * versions).
 *
 * Presentational: the note lives in the CALLER's state, so cancelling and
 * reopening restores what was typed, and an unmount can't silently eat it.
 * Shared by every send surface — the file-viewer dialog and the Present tab
 * (both via `FileReviewFooter`) and `DiffPanel`.
 */

import { PaperPlaneTiltIcon } from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import { ICON_SIZE } from "../design-tokens.js";
import type { FileReviewControls } from "../hooks/use-file-review-controls.js";

export function SendReviewDialog({
  open,
  commentCount,
  target,
  note,
  onNoteChange,
  onSend,
  onClose,
}: {
  open: boolean;
  commentCount: number;
  /** What the comments are on: a file path, or "3 files" for a diff review. */
  target: string;
  note: string;
  onNoteChange: (note: string) => void;
  onSend: () => void;
  onClose: () => void;
}) {
  const countLabel = `${commentCount} comment${commentCount !== 1 ? "s" : ""}`;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="w-full md:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send review</DialogTitle>
        </DialogHeader>

        <div className="px-5 py-4 flex flex-col gap-3">
          <DialogDescription>
            {countLabel} on{" "}
            <span className="font-mono text-xs text-(--color-text-primary) break-all">{target}</span>
          </DialogDescription>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="send-review-note"
              className="flex items-baseline gap-1.5 text-sm font-medium text-(--color-text-primary)"
            >
              Add a note for the agent
              <span className="text-xs font-normal text-(--color-text-tertiary)">optional</span>
            </label>
            <textarea
              id="send-review-note"
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              // ⌘⏎ / Ctrl+⏎ sends from inside the dialog. This is NOT a bypass:
              // the dialog still always opens first (req 8).
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onSend();
                }
              }}
              rows={4}
              autoFocus
              placeholder="Anything the comments don't say — priorities, constraints, why you're asking, what to leave alone…"
              className="w-full resize-y rounded-lg border border-(--color-border-secondary) bg-(--color-bg-primary) px-3 py-2 text-sm text-(--color-text-primary) placeholder:text-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
            />
            <p className="text-xs text-(--color-text-tertiary)">
              Goes first in the message, before the comments.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onSend}>
            <PaperPlaneTiltIcon size={ICON_SIZE.SM} className="mr-1" />
            Send {countLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The same dialog, bound to `useFileReviewControls`. Both file-review surfaces
 * (the file-viewer dialog and the Present tab) render it through
 * `FileReviewFooter`'s `sendDialog` slot, so neither has to restate the wiring.
 * `DiffPanel` keeps its own comment state and uses `SendReviewDialog` directly.
 */
export function FileReviewSendDialog({
  controls,
  filePath,
}: {
  controls: FileReviewControls;
  filePath: string;
}) {
  return (
    <SendReviewDialog
      open={controls.sendDialogOpen}
      commentCount={controls.commentCount}
      target={filePath}
      note={controls.note}
      onNoteChange={controls.setNote}
      onSend={() => { void controls.confirmSend(); }}
      onClose={controls.closeSendDialog}
    />
  );
}
