

// eslint-disable-next-line no-restricted-imports -- useEffect: one-shot draft load tied to (session, file) identity
import { useEffect, useMemo, useCallback, useState } from "react";
import { useFileReviewStore } from "../stores/file-review-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import {
  isRepoReviewablePath,
  supportsKindReview,
  type ContentKind,
} from "../utils/file-content-kind.js";
import type { SelectionCommentData } from "../components/MarkdownSelectionComments.js";
import type { SendCommentsPayload } from "../components/FilePreviewModal.js";
import type { ReviewComment, FileReview } from "../../server/shared/types.js";

const EMPTY_HISTORY: FileReview[] = [];

export interface UseFileReviewControlsArgs {
  filePath: string;
  kind: ContentKind;
  content: string | null;
  onSendComments?: (payload: SendCommentsPayload) => void;
  onAskAgentReview?: (filePath: string) => void;
}

export interface FileReviewControls {

  reviewable: boolean;

  commentCount: number;

  markdownComments: SelectionCommentData[];

  codeComments: { id: string; kind: "line"; line: number; text: string }[];

  history: FileReview[];

  canSend: boolean;

  sendDialogOpen: boolean;

  note: string;
  setNote: (note: string) => void;

  closeSendDialog: () => void;

  confirmSend: () => Promise<void>;

  sending: boolean;

  sendError: string | null;

  composing: boolean;

  showAskReview: boolean;

  agentRunning: boolean;

  handleSend: () => void;

  handleAskReview: () => void;

  discardEmptyDraftNow: () => void;
}

export function useFileReviewControls({
  filePath,
  kind,
  content,
  onSendComments,
  onAskAgentReview,
}: UseFileReviewControlsArgs): FileReviewControls {
  const sessionId = useSessionStore((s) => s.sessionId) ?? "";

  const agentRunning = useSessionStore((s) => s.isLoading);

  const activeAgentId = useUiStore((s) => s.activeAgentId);
  const agentList = useUiStore((s) => s.agentList);
  const activeAgentSupportsReview =
    agentList.find((a) => a.id === activeAgentId)?.supportsReview ?? false;

  const key = sessionId && filePath ? `${sessionId}::${filePath}` : null;
  const draft = useFileReviewStore((s) => (key ? s.draftByKey[key] ?? null : null));
  const history = useFileReviewStore((s) =>
    key ? s.historyByKey[key] ?? EMPTY_HISTORY : EMPTY_HISTORY,
  );
  const composing = useFileReviewStore((s) => (key ? s.composingByKey[key] ?? false : false));
  const load = useFileReviewStore((s) => s.load);
  const sendDraft = useFileReviewStore((s) => s.sendDraft);
  const discardEmptyDraft = useFileReviewStore((s) => s.discardEmptyDraft);

  // Only workspace-relative paths are addressable by the review API; kind must

  const reviewable =
    !!sessionId && !!filePath && isRepoReviewablePath(filePath) && supportsKindReview(kind);

  // eslint-disable-next-line no-restricted-syntax -- one-shot fetch tied to (session, file) identity
  useEffect(() => {
    if (!sessionId || !reviewable || content === null) return;
    void load(sessionId, filePath);
  }, [sessionId, filePath, reviewable, content, load]);

  const commentCount = draft?.comments.length ?? 0;

  const markdownComments: SelectionCommentData[] = useMemo(() => {
    return (draft?.comments ?? [])
      .filter((c): c is Extract<ReviewComment, { kind: "selection" }> => c.kind === "selection")
      .map((c) => ({
        id: c.id,
        quotedText: c.quotedText,
        contextBefore: c.contextBefore,
        contextAfter: c.contextAfter,
        text: c.text,
      }));
  }, [draft]);

  const codeComments = useMemo(() => {
    return (draft?.comments ?? [])
      .filter((c): c is Extract<ReviewComment, { kind: "line" }> => c.kind === "line")
      .map((c) => ({ id: c.id, kind: "line" as const, line: c.line, text: c.text }));
  }, [draft]);

  const reviewableForAgent =
    kind === "markdown"
    || ((kind === "code" || kind === "html" || kind === "svg") && (content?.length ?? 0) <= 10 * 1024);
  const showAskReview =
    reviewable
    && reviewableForAgent
    && content !== null
    && activeAgentSupportsReview
    && !!onAskAgentReview;

  const canSend = !!onSendComments && commentCount > 0 && !composing;

  const handleAskReview = useCallback(() => {
    if (!sessionId || !onAskAgentReview || agentRunning) return;
    onAskAgentReview(filePath);
  }, [sessionId, filePath, onAskAgentReview, agentRunning]);

  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [dialogFileKey, setDialogFileKey] = useState(key);
  if (dialogFileKey !== key) {
    setDialogFileKey(key);
    setSendDialogOpen(false);
    setNote("");
    setSending(false);
    setSendError(null);
  }

  const handleSend = useCallback(() => {
    // Mirrors the disabled button: never open out from under an open editor.
    if (!sessionId || !onSendComments || composing || commentCount === 0) return;
    setSendError(null);
    setSendDialogOpen(true);
  }, [sessionId, onSendComments, composing, commentCount]);

  const closeSendDialog = useCallback(() => setSendDialogOpen(false), []);

  const confirmSend = useCallback(async () => {
    if (!sessionId || !onSendComments || composing) return;

    if (sending) return;
    setSending(true);
    setSendError(null);
    let result;
    try {
      result = await sendDraft(sessionId, filePath, note);
    } finally {
      setSending(false);
    }
    if (!result) {

      // success — no card, no message, and a review that was never sent.
      setSendError("Couldn't send the review. Check your connection and try again.");
      return;
    }
    setSendDialogOpen(false);

    setNote("");
    onSendComments({
      prompt: result.prompt,
      filePaths: [result.filePath],
      commentCount: result.commentCount,
    });
  }, [sessionId, filePath, sendDraft, onSendComments, composing, note, sending]);

  const discardEmptyDraftNow = useCallback(() => {

    if (sessionId && reviewable) {
      void discardEmptyDraft(sessionId, filePath);
    }
  }, [sessionId, reviewable, filePath, discardEmptyDraft]);

  return {
    reviewable,
    commentCount,
    markdownComments,
    codeComments,
    history,
    canSend,
    composing,
    showAskReview,
    agentRunning,
    handleSend,
    sendDialogOpen,
    note,
    setNote,
    closeSendDialog,
    confirmSend,
    sending,
    sendError,
    handleAskReview,
    discardEmptyDraftNow,
  };
}
