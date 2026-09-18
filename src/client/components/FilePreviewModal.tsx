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

export interface SendCommentsPayload {
  prompt: string;
  filePaths: string[];
  commentCount: number;
}

export interface FilePreviewAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "default";
}

export interface FilePreviewSibling {
  path: string;
  label: string;
}

export interface FilePreviewModalProps {
  filePath: string;
  content: string | null;
  fileType: FilePreviewType;
  line?: number | null;
  actions?: FilePreviewAction[];
  fileOnDisk?: boolean;
  siblings?: FilePreviewSibling[];
  onSwitchSibling?: (path: string) => void;
  onClose: () => void;
  onSendComments?: (payload: SendCommentsPayload) => void;
  onAskAgentReview?: (filePath: string) => void;
}

// Encode path segments without hiding route separators.
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

  // The server rejects writes to sessions that remain in the warm pool.
  const sessionGraduated = useSessionStore((s) =>
    s.sessions.some((x) => x.id === s.sessionId),
  );
  const showEdit =
    !!fileOnDisk && !!sessionId && sessionGraduated && isEditableFilePath(filePath);

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
