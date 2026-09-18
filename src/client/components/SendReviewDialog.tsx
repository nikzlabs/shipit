

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

export const MAX_NOTE_LENGTH = 4000;

export function SendReviewDialog({
  open,
  commentCount,
  target,
  note,
  onNoteChange,
  onSend,
  onClose,
  sending = false,
  error = null,
}: {
  open: boolean;
  commentCount: number;

  target: string;
  note: string;
  onNoteChange: (note: string) => void;
  onSend: () => void;
  onClose: () => void;

  sending?: boolean;

  error?: string | null;
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

              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !sending) {
                  e.preventDefault();
                  onSend();
                }
              }}
              rows={4}
              maxLength={MAX_NOTE_LENGTH}
              autoFocus
              placeholder="Anything the comments don't say — priorities, constraints, why you're asking, what to leave alone…"
              className="w-full resize-y rounded-lg border border-(--color-border-secondary) bg-(--color-bg-primary) px-3 py-2 text-sm text-(--color-text-primary) placeholder:text-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
            />
            <p className="text-xs text-(--color-text-tertiary)">
              Goes first in the message, before the comments.
            </p>
            {error && (
              <p role="alert" className="text-xs text-(--color-error)">
                {error}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onSend} disabled={sending}>
            <PaperPlaneTiltIcon size={ICON_SIZE.SM} className="mr-1" />
            {sending ? "Sending…" : `Send ${countLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
      sending={controls.sending}
      error={controls.sendError}
    />
  );
}
