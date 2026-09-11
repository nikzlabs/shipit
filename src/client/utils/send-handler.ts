

import type { SendPayload } from "../components/MessageInput/MessageInput.js";
import { useSessionStore } from "../stores/session-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useFileStore } from "../stores/file-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { sendUserMessage } from "./send-user-message.js";
import { buildAttachmentPlan } from "./attachment-plan.js";
import { isReviewCommand, resolveReviewRequest } from "./review-command.js";
import { composeReviewMessage, resolveReviewer } from "./compose-review-body.js";

export interface SendDeps {
  /** Put a frame on the wire. `false` means the bytes never left the browser. */
  send: (data: unknown) => boolean;
  requestPermission: () => void;
  disableAutoFix: () => void;
  navigate: (to: string, opts: { replace: boolean }) => unknown;

  isNewSessionRoute: boolean;
}

export function runSend(deps: SendDeps, payload: SendPayload): boolean {
  const { send, requestPermission, disableAutoFix, navigate, isNewSessionRoute } = deps;
  const {
    text,
    uploadRefs,
    uploads: payloadUploads,
    resetMergedBranch,
    compactContext,
    dictated,
  } = payload;

  const trimmed = text.trim();

  const plan = buildAttachmentPlan({
    text: trimmed,
    uploadRefs,
    uploads: payloadUploads,
    pendingFiles: useSettingsStore.getState().pendingFiles,
  });
  if (isReviewCommand(trimmed)) {
    const reviewSettings = useSettingsStore.getState();
    const request = resolveReviewRequest({
      text: trimmed,
      sessionId: useSessionStore.getState().sessionId,
      turnRunning: useSessionStore.getState().isLoading,
      previewFile: useFileStore.getState().previewFile,
    });

    if (!request.ok) {
      useUiStore.getState().setToast({ message: request.message });
      return false;
    }
    const { sessionId: sid, targetFile } = request;
    const prompt = composeReviewMessage(
      targetFile,
      resolveReviewer({
        enableSubAgents: useSettingsStore.getState().enableSubAgents,
        activeAgentId: useUiStore.getState().activeAgentId,
      }),
    );

    const reviewSent = sendUserMessage({
      bubble: { role: "user", text: prompt, ...plan.bubble },
      activity: "Reviewing...",
      dispatch: (requestId) =>
        send({
          type: "send_message",
          requestId,
          text: prompt,
          sessionId: sid,
          ...plan.frame,

          ...(resetMergedBranch !== undefined ? { resetMergedBranch } : {}),
          ...(compactContext !== undefined ? { compactContext } : {}),
        }),
    });
    // docs/293 req 4 — the frame never left the browser. `sendUserMessage` has

    // in a moment, which they cannot do if the composer emptied itself behind

    if (!reviewSent) return false;

    // line is here rather than above the dispatch because a refused send has to

    if (isNewSessionRoute) {

      void navigate(`/session/${sid}`, { replace: true });
    }
    useFileStore.getState().closePreview();
    if (plan.clearAttachments) reviewSettings.clearPendingFiles();
    return true;
  }

  requestPermission();
  disableAutoFix();
  const session = useSessionStore.getState();
  const settings = useSettingsStore.getState();
  useUiStore.getState().setShowTemplates(false);
  const filesForMessage = plan.bubble.files;
  const imagesForMessage = plan.bubble.images;
  const uploadPathsForMessage = plan.bubble.uploadPaths;

  const currentSessionId = session.sessionId;
  if (currentSessionId) {

    if (isNewSessionRoute) {
      void navigate(`/session/${currentSessionId}`, { replace: true });
    }

    // pin the user to that session, and the ref must not follow them into an

    const pendingIssue = useSessionStore.getState().pendingIssueRef;
    const issueRef =
      pendingIssue?.sessionId === currentSessionId ? pendingIssue.ref : undefined;

    const message = {
      type: "send_message" as const,
      text,
      sessionId: currentSessionId,
      ...(issueRef ? { issueRef } : {}),
      ...plan.frame,
      permissionMode: (() => {
        const pm = settings.getPermissionMode(currentSessionId);
        return pm !== "auto" ? pm : undefined;
      })(),

      ...(resetMergedBranch !== undefined ? { resetMergedBranch } : {}),

      ...(compactContext !== undefined ? { compactContext } : {}),

      ...(dictated ? { dictated: true } : {}),
    };

    const sent = sendUserMessage({
      bubble: {
        role: "user",
        text,
        files: filesForMessage,
        images: imagesForMessage,
        uploadPaths: uploadPathsForMessage,
      },
      activity: "Thinking...",
      dispatch: (requestId) => {
        const frame = { ...message, requestId };
        if (send(frame)) return true;

        useSessionStore.getState().setPendingWsMessage(frame);
        return true;
      },
    });

    if (issueRef && sent) useSessionStore.getState().setPendingIssueRef(undefined);

    if (!sent) return false;
  } else {

    console.warn("[session] No active session — cannot send message");
    session.setMessages((prev) => [
      ...prev,
      {
        role: "user",
        text,
        files: filesForMessage,
        images: imagesForMessage,
        uploadPaths: uploadPathsForMessage,
      },
    ]);
  }
  if (plan.clearAttachments) settings.clearPendingFiles();

  return true;
}
