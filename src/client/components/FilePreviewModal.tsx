// eslint-disable-next-line no-restricted-imports -- useEffect: reset view mode on file change
import { useEffect, useCallback, useState } from "react";
import { RobotIcon, DownloadSimpleIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { Button, buttonVariants } from "./ui/button.js";
import { FileContentView } from "./FileContentView/FileContentView.js";
import { FileReviewFooter } from "./FileContentView/FileReviewFooter.js";
import { FileReviewSendDialog } from "./SendReviewDialog.js";
import { SourceToggle, type ViewMode } from "./FileContentView/SourceToggle.js";
import { useSessionStore } from "../stores/session-store.js";
import { useFileStore } from "../stores/file-store.js";
import { useFileReviewControls } from "../hooks/use-file-review-controls.js";
import { kindFromPreviewType, supportsSourceToggle } from "../utils/file-content-kind.js";
import { isEditableFilePath, type FilePreviewType } from "../utils/file-preview-type.js";
import { WithTooltip } from "./ui/tooltip.js";

/**
 * Payload handed to `onSendComments` when the user submits review comments
 * from this modal or the diff panel. Carries the full prompt the server
 * built plus structured metadata (filePaths + commentCount) so the chat
 * surface can render a "Sent comments" card without re-parsing the prompt.
 */
export interface SendCommentsPayload {
  prompt: string;
  /** Files the comments are anchored to. May contain multiple entries for diffs. */
  filePaths: string[];
  /** Number of comments included in the submission. */
  commentCount: number;
}

export interface FilePreviewAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "default";
}

export interface FilePreviewSibling {
  /** Full file path (matches the modal's `filePath` when this tab is active). */
  path: string;
  /** Short label shown in the tab strip (e.g. "Plan", "Checklist"). */
  label: string;
}

export interface FilePreviewModalProps {
  filePath: string;
  content: string | null;
  fileType: FilePreviewType;
  /**
   * 1-based line to reveal and highlight when the code view mounts (e.g. from a
   * `path:line` link). Ignored for markdown/image/binary. `null` opens at the top.
   */
  line?: number | null;
  actions?: FilePreviewAction[];
  /**
   * Whether the previewed file exists on disk in the session workspace. When
   * true the modal renders its own Download and Edit controls — both belong to
   * the preview itself, not to whichever surface opened it, so a doc opened
   * from the PR card behaves like one opened from the file tree. False for an
   * in-memory preview (a pasted image), which has no path either the download
   * route or the editor could resolve.
   */
  fileOnDisk?: boolean;
  /**
   * Optional sibling docs in the same directory. When more than one is
   * provided, the modal renders a tab strip in the header. The active tab is
   * the entry whose `path` equals `filePath`.
   */
  siblings?: FilePreviewSibling[];
  /**
   * Called when the user clicks a sibling tab. The caller is expected to
   * load the new file (e.g. via `openPreview`) — the modal stays open and
   * its content swaps via the parent-driven `filePath`/`content` props.
   */
  onSwitchSibling?: (path: string) => void;
  onClose: () => void;
  /**
   * Called after the user clicks Send. Receives the prompt the server already
   * built from the (now-sent) review, plus structured metadata so the chat
   * surface can render a "Sent comments" card without parsing the prompt
   * back. Caller dispatches the prompt via the existing `send_message` flow.
   */
  onSendComments?: (payload: SendCommentsPayload) => void;
  /**
   * docs/203, docs/220 — called when the user clicks "Ask agent to review".
   * Receives the file path; the caller (App.tsx) resolves the reviewer, composes
   * the prompt, and sends it as a normal message, then closes the modal.
   */
  onAskAgentReview?: (filePath: string) => void;
}

/**
 * URL of the raw-file download route for a previewed path. Each path segment is
 * encoded separately so a name carrying `#`, `?`, or a space survives the trip
 * while the `/` separators stay real separators for the route's wildcard param.
 * A leading slash is dropped the same way `openPreview` drops it, so an upload
 * path (`/uploads/x.png`) resolves against the session directory rather than
 * producing an empty first segment.
 */
function fileDownloadHref(sessionId: string, filePath: string): string {
  const relative = filePath.startsWith("/") ? filePath.slice(1) : filePath;
  const encoded = relative.split("/").map(encodeURIComponent).join("/");
  return `/api/sessions/${sessionId}/files/download/${encoded}`;
}

export function FilePreviewModal({
  filePath,
  content,
  fileType,
  line,
  actions,
  siblings,
  onSwitchSibling,
  fileOnDisk,
  onClose,
  onSendComments,
  onAskAgentReview,
}: FilePreviewModalProps) {
  const sessionId = useSessionStore((s) => s.sessionId) ?? "";
  const kind = kindFromPreviewType(fileType, filePath);

  // Direct editing needs a graduated session (one that has left the warm pool
  // and so is present in the sessions list) — the server rejects a write to a
  // warm session either way. Gated here rather than at the call sites so every
  // surface that opens a preview offers the same controls; `isEditableFilePath`
  // rules out binaries, images and uploads.
  const sessionGraduated = useSessionStore((s) =>
    s.sessions.some((x) => x.id === s.sessionId),
  );
  const showEdit =
    !!fileOnDisk && !!sessionId && sessionGraduated && isEditableFilePath(filePath);

  // HTML/SVG default to rendered; a small toggle in the header flips to source.
  const [viewMode, setViewMode] = useState<ViewMode>("rendered");
  // eslint-disable-next-line no-restricted-syntax -- reset toggle when the previewed file changes
  useEffect(() => { setViewMode("rendered"); }, [filePath]);

  const review = useFileReviewControls({
    filePath,
    kind,
    content,
    onSendComments,
    onAskAgentReview,
  });

  const handleClose = useCallback(() => {
    review.discardEmptyDraftNow();
    onClose();
  }, [review, onClose]);

  const handleSwitchSibling = useCallback(
    (nextPath: string) => {
      if (nextPath === filePath || !onSwitchSibling) return;
      // Discard an empty draft on the outgoing tab so it doesn't linger.
      review.discardEmptyDraftNow();
      onSwitchSibling(nextPath);
    },
    [filePath, onSwitchSibling, review],
  );

  const showSiblingTabs = !!siblings && siblings.length > 1;
  const showToggle = supportsSourceToggle(kind) && content !== null;
  const showFooter =
    review.reviewable
    && content !== null
    && (review.commentCount > 0 || review.history.length > 0);

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent className="w-[90vw] max-w-4xl h-[85vh] flex flex-col">
        {/* Header */}
        <div className="border-b border-(--color-border-secondary) shrink-0">
          {/* pr-14 clears the dialog's corner close button so the controls don't sit under it */}
          <div className="flex items-center justify-between px-6 py-4 pr-14">
            <div className="min-w-0">
              <DialogTitle className="text-sm font-medium text-(--color-text-primary) truncate" title={filePath}>
                {filePath}
              </DialogTitle>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-4">
              {showToggle && <SourceToggle value={viewMode} onChange={setViewMode} />}
              {review.showAskReview && (
                <WithTooltip label={review.agentRunning ? "Wait for the current turn to finish" : "Start a chat review turn"}>
                  <Button variant="secondary" size="md" onClick={review.handleAskReview} disabled={review.agentRunning}>
                    <RobotIcon size={ICON_SIZE.SM} className="mr-1" />
                    Ask agent to review
                  </Button>
                </WithTooltip>
              )}
              {showEdit && (
                <WithTooltip label="Edit file">
                  <Button
                    variant="secondary"
                    size="md"
                    aria-label={`Edit ${filePath}`}
                    onClick={() => {
                      void useFileStore.getState().openEditor(sessionId, filePath);
                    }}
                  >
                    <PencilSimpleIcon size={ICON_SIZE.SM} />
                  </Button>
                </WithTooltip>
              )}
              {fileOnDisk && sessionId && (
                <WithTooltip label="Download file">
                  <a
                    href={fileDownloadHref(sessionId, filePath)}
                    download
                    aria-label={`Download ${filePath}`}
                    className={buttonVariants({ variant: "secondary", size: "md" })}
                  >
                    <DownloadSimpleIcon size={ICON_SIZE.SM} />
                  </a>
                </WithTooltip>
              )}
              {actions?.map((action) => (
                <Button
                  key={action.label}
                  variant={action.variant === "primary" ? "primary" : "secondary"}
                  size="md"
                  onClick={action.onClick}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          </div>
          {showSiblingTabs && siblings && (
            <div
              className="flex px-4 overflow-x-auto overflow-y-hidden overscroll-x-contain"
              role="tablist"
              aria-label="Related docs"
            >
              {siblings.map((sib) => {
                const active = sib.path === filePath;
                return (
                  <button
                    key={sib.path}
                    role="tab"
                    aria-selected={active}
                    onClick={() => handleSwitchSibling(sib.path)}
                    className={`shrink-0 whitespace-nowrap px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer border-b-2 -mb-px ${
                      active
                        ? "text-(--color-text-primary) border-(--color-accent)"
                        : "text-(--color-text-tertiary) border-transparent hover:text-(--color-text-secondary)"
                    }`}
                  >
                    {sib.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0">
          {content === null ? (
            <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
              Loading...
            </div>
          ) : (
            <FileContentView
              key={filePath}
              filePath={filePath}
              content={content}
              kind={kind}
              sessionId={sessionId}
              viewMode={viewMode}
              reviewable={review.reviewable}
              revealLine={line ?? undefined}
              markdownComments={review.markdownComments}
              codeComments={review.codeComments}
            />
          )}
        </div>

        {/* Footer — review controls (live mode only) */}
        {showFooter && (
          <FileReviewFooter
            commentCount={review.commentCount}
            history={review.history}
            canSend={review.canSend}
            composing={review.composing}
            onSend={review.handleSend}
            onCancel={handleClose}
            sendDialog={<FileReviewSendDialog controls={review} filePath={filePath} />}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
