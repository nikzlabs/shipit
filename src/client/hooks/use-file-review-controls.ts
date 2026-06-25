/**
 * use-file-review-controls — the review draft/history/send/ask state shared by
 * the file-viewer dialog (`FilePreviewModal`) and the Present tab (`PresentPane`),
 * per docs/219.
 *
 * It owns the `file-review-store` interaction (the renderer, `FileContentView`,
 * stays pure) and reproduces the modal's full `showAskReview` gating so both
 * surfaces behave identically: active-agent `supportsReview` capability, agent
 * not mid-turn, content loaded, and the markdown-any-size / source-under-10KB
 * size rule. Reviewability is path- + kind-gated (`isRepoReviewablePath` +
 * `supportsKindReview`), so a non-workspace artifact (e.g. a `/persist` present
 * file) renders read-only with no draft.
 *
 * Call it UNCONDITIONALLY (before any early return) — PresentPane passes
 * `filePath = active?.filePath ?? ""` so the hook order stays stable.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: one-shot draft load tied to (session, file) identity
import { useEffect, useMemo, useCallback } from "react";
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
  /** True when this (path, kind) can carry server-addressable review comments. */
  reviewable: boolean;
  /** Number of comments in the current draft. */
  commentCount: number;
  /** Selection comments for markdown review. */
  markdownComments: SelectionCommentData[];
  /** Line comments for the code/source view. */
  codeComments: { id: string; kind: "line"; line: number; text: string }[];
  /** Sent-review history for this file. */
  history: FileReview[];
  /** Whether the Send button should be enabled. */
  canSend: boolean;
  /** Whether the "Ask agent to review" affordance should show. */
  showAskReview: boolean;
  /** True while the agent is mid-turn (Ask-review is disabled, not hidden). */
  agentRunning: boolean;
  /** Send the draft; surfaces the constructed prompt to `onSendComments`. */
  handleSend: () => Promise<void>;
  /** Start a chat-native review turn via `onAskAgentReview`. */
  handleAskReview: () => void;
  /** Discard an empty draft (on close / sibling switch / carousel nav / tab blur). */
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
  // Agent-busy state: a review is a chat turn, so we can't start one while the
  // agent is mid-turn. The button stays visible but disabled.
  const agentRunning = useSessionStore((s) => s.isLoading);

  // Ask-review is gated on the active agent backend's `supportsReview`
  // capability (Codex hides the affordance entirely — docs/125).
  const activeAgentId = useUiStore((s) => s.activeAgentId);
  const agentList = useUiStore((s) => s.agentList);
  const activeAgentSupportsReview =
    agentList.find((a) => a.id === activeAgentId)?.supportsReview ?? false;

  // Stable references so Zustand doesn't treat each render as a state change.
  const key = sessionId && filePath ? `${sessionId}::${filePath}` : null;
  const draft = useFileReviewStore((s) => (key ? s.draftByKey[key] ?? null : null));
  const history = useFileReviewStore((s) =>
    key ? s.historyByKey[key] ?? EMPTY_HISTORY : EMPTY_HISTORY,
  );
  const load = useFileReviewStore((s) => s.load);
  const sendDraft = useFileReviewStore((s) => s.sendDraft);
  const discardEmptyDraft = useFileReviewStore((s) => s.discardEmptyDraft);

  // Only workspace-relative paths are addressable by the review API; kind must
  // be one that carries comments (markdown selection, or code/html/svg lines).
  const reviewable =
    !!sessionId && !!filePath && isRepoReviewablePath(filePath) && supportsKindReview(kind);

  // Load draft + history when a reviewable file's content is available.
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
        source: c.source,
      }));
  }, [draft]);

  const codeComments = useMemo(() => {
    return (draft?.comments ?? [])
      .filter((c): c is Extract<ReviewComment, { kind: "line" }> => c.kind === "line")
      .map((c) => ({ id: c.id, kind: "line" as const, line: c.line, text: c.text }));
  }, [draft]);

  // The subagent can usefully review markdown of any size, or a source view
  // (code/html/svg) under a cap (binaries/huge generated files get no
  // affordance). 10 KB cap per docs/203.
  const reviewableForAgent =
    kind === "markdown"
    || ((kind === "code" || kind === "html" || kind === "svg") && (content?.length ?? 0) <= 10 * 1024);
  const showAskReview =
    reviewable
    && reviewableForAgent
    && content !== null
    && activeAgentSupportsReview
    && !!onAskAgentReview;
  const canSend = !!onSendComments && commentCount > 0;

  const handleAskReview = useCallback(() => {
    if (!sessionId || !onAskAgentReview || agentRunning) return;
    onAskAgentReview(filePath);
  }, [sessionId, filePath, onAskAgentReview, agentRunning]);

  const handleSend = useCallback(async () => {
    if (!sessionId || !onSendComments) return;
    const result = await sendDraft(sessionId, filePath);
    if (result) {
      onSendComments({
        prompt: result.prompt,
        filePaths: [result.filePath],
        commentCount: result.commentCount,
      });
    }
  }, [sessionId, filePath, sendDraft, onSendComments]);

  const discardEmptyDraftNow = useCallback(() => {
    // The store guards on emptiness, so this is a no-op when comments exist.
    if (sessionId && reviewable && draft?.comments.length === 0) {
      void discardEmptyDraft(sessionId, filePath);
    }
  }, [sessionId, reviewable, draft, filePath, discardEmptyDraft]);

  return {
    reviewable,
    commentCount,
    markdownComments,
    codeComments,
    history,
    canSend,
    showAskReview,
    agentRunning,
    handleSend,
    handleAskReview,
    discardEmptyDraftNow,
  };
}
