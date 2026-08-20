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
  /** docs/260 — the send-confirmation dialog is open. */
  sendDialogOpen: boolean;
  /** The dialog's free-text note. Held here, not in the dialog, so cancelling
   *  and reopening restores what was typed. */
  note: string;
  setNote: (note: string) => void;
  /** Close the dialog without sending. The draft and the note both survive. */
  closeSendDialog: () => void;
  /** Send the draft with the note. Called by the dialog's Send button. */
  confirmSend: () => Promise<void>;
  /** True while the send request is in flight — holds off a second confirm. */
  sending: boolean;
  /** Why the last send failed, or null. The dialog stays open and shows it. */
  sendError: string | null;
  /**
   * True while an unsaved comment editor is open (add-comment input or an
   * in-place edit). Blocks `canSend` so an accidental submit can't drop a
   * half-typed comment; surfaces render it as a hint next to the button.
   */
  composing: boolean;
  /** Whether the "Ask agent to review" affordance should show. */
  showAskReview: boolean;
  /** True while the agent is mid-turn (Ask-review is disabled, not hidden). */
  agentRunning: boolean;
  /** Open the send-confirmation dialog (docs/260). The send itself is
   *  `confirmSend`, from inside the dialog. */
  handleSend: () => void;
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
  // capability. Every shipped harness declares it (docs/266 item 15 — the flow
  // needs a shell tool and a subagent primitive, not MCP), so today this only
  // guards the `?? false` default and whatever harness comes next. Note the
  // asymmetry it creates: `/review` in the composer is UNGATED and composes the
  // identical prompt, so a `false` here hides a button rather than the feature.
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
  const composing = useFileReviewStore((s) => (key ? s.composingByKey[key] ?? false : false));
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
  // An open comment editor holds the Send button: submitting now would send the
  // draft and silently discard whatever is still in the textarea.
  const canSend = !!onSendComments && commentCount > 0 && !composing;

  const handleAskReview = useCallback(() => {
    if (!sessionId || !onAskAgentReview || agentRunning) return;
    onAskAgentReview(filePath);
  }, [sessionId, filePath, onAskAgentReview, agentRunning]);

  // docs/260 — Send opens a confirmation dialog instead of sending. The note
  // lives here rather than in the dialog so a cancel (or an unmount) doesn't
  // discard what was typed.
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // This hook FOLLOWS the surface's active file — the file viewer swaps
  // siblings and Present swaps carousel entries through the same instance. The
  // draft and history are keyed by (session, file) so they follow along, but
  // the dialog state is plain component state: without this reset, a note typed
  // for file A would still be in the box for file B — and sending would attach
  // A's note to B's review. Render-phase reset (React's "adjust state when a
  // prop changes" pattern) so no stale value is ever rendered.
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
    // The dialog has two send affordances (the button and ⌘⏎) and the POST is
    // async, so without this guard a second confirm while the first is in
    // flight sends the review twice — two prompts, two agent turns.
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
      // Keep the dialog open and say so. Closing on failure looked exactly like
      // success — no card, no message, and a review that was never sent.
      setSendError("Couldn't send the review. Check your connection and try again.");
      return;
    }
    setSendDialogOpen(false);
    // Only clear the note once the send succeeded — a failed send keeps it so
    // the user can retry without retyping.
    setNote("");
    onSendComments({
      prompt: result.prompt,
      filePaths: [result.filePath],
      commentCount: result.commentCount,
    });
  }, [sessionId, filePath, sendDraft, onSendComments, composing, note, sending]);

  const discardEmptyDraftNow = useCallback(() => {
    // Deliberately does NOT pre-check `draft`. Callers capture this callback at
    // effect-setup so the cleanup targets the OUTGOING file, which means a
    // captured `draft` can be arbitrarily stale — and the common sequence
    // (`draft` null while the async load is in flight → an empty draft arrives →
    // the user navigates away) would then skip the discard entirely and leak the
    // empty draft. The store re-reads the draft and bails when it is absent or
    // non-empty (`file-review-store.ts` → `discardEmptyDraft`), so it is the
    // authoritative guard; calling unconditionally can only ever be a no-op.
    // Omitting `draft` from the deps also keeps this callback stable across
    // draft mutations, which is what the capturing effects want.
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
