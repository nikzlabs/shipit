/**
 * What the composer's Send does — the whole decision, in one place a test can
 * call.
 *
 * docs/293 req 4. This body used to live inside `App.handleSend`, and `App` has
 * no test harness, so three PRs in a row had to extract a *pure* helper out of
 * it and then state the same gap: the helper is tested, App's **call** to it is
 * not. `buildAttachmentPlan` could not catch App forgetting to spread
 * `plan.frame`; `resolveReviewRequest` could not catch App failing to return the
 * refusal, which is exactly the bug req 4 is about.
 *
 * So the body moved rather than another piece of it. It is not pure — it reads
 * stores and dispatches — but everything React-shaped is a parameter, so a test
 * seeds the stores, calls this with a fake `send`, and reads back what went on
 * the wire and what the return value told the composer to do.
 */

import type { SendPayload } from "../components/MessageInput/MessageInput.js";
import { useSessionStore } from "../stores/session-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useFileStore } from "../stores/file-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { sendUserMessage } from "./send-user-message.js";
import { buildAttachmentPlan } from "./attachment-plan.js";
import { isReviewCommand, resolveReviewRequest } from "./review-command.js";
import { composeReviewMessage, resolveReviewer } from "./compose-review-body.js";

/**
 * Everything `runSend` needs that does not come from a store — i.e. everything
 * that would otherwise force a test to render `App`.
 */
export interface SendDeps {
  /** Put a frame on the wire. `false` means the bytes never left the browser. */
  send: (data: unknown) => boolean;
  requestPermission: () => void;
  disableAutoFix: () => void;
  navigate: (to: string, opts: { replace: boolean }) => unknown;
  /** Whether the user is on a `/{slug}/new` route that still has to graduate. */
  isNewSessionRoute: boolean;
}

/**
 * Returns `false` when this send was **refused** and nothing was dispatched, so
 * the composer keeps the text and the attachments it would otherwise have
 * cleared. Deliberately synchronous: the refusal has to reach `MessageInput` in
 * the same tick it clears in, and nothing here awaits.
 */
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
  // docs/203, docs/220 — `/review [@path]` is a chat-native entry point to AI
  // review: same composed prompt as the modal button, sent as a normal
  // `send_message`. The reviewer (cross-agent vs fresh subagent) is resolved
  // here, at click time, from the settings store + agent registry — the prompt
  // is concrete. Cross-agent output is surfaced by the consult card (docs/220);
  // a same-model review is narrated as prose. No review tool is involved.
  const trimmed = text.trim();
  // docs/294 — one decision about the composer's attachments, made in a pure
  // function so it can be tested on its own. Every branch below carries it out
  // rather than answering it again.
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
    // docs/293 req 4 — refused, so nothing is dispatched and the composer is
    // told to keep what it has. The toast explains the refusal; the attachment
    // is still there when the user has acted on it.
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
    // docs/293 req 4 — carry the composer's attachments too. This path composes
    // its own prompt and used to dispatch it alone, while `handleSubmit` cleared
    // the chips regardless: an upload attached alongside `/review` vanished with
    // no message and no error.
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
          // docs/218 + docs/295 — `/review` is still a composer send, so it
          // carries the per-send tick boxes.
          ...(resetMergedBranch !== undefined ? { resetMergedBranch } : {}),
          ...(compactContext !== undefined ? { compactContext } : {}),
        }),
    });
    // docs/293 req 4 — the frame never left the browser. `sendUserMessage` has
    // already rolled its optimistic bubble back and told the user to try again
    // in a moment, which they cannot do if the composer emptied itself behind
    // that toast. Unlike the ordinary send below, this dispatch does not stash
    // the frame for reconnect, so this is reachable.
    if (!reviewSent) return false;
    // Everything below is what an ACCEPTED `/review` leaves behind, and each
    // line is here rather than above the dispatch because a refused send has to
    // be retryable. `closePreview` clears `previewFile`, which is the target a
    // bare `/review` resolves from — closing it first means the retry the toast
    // asks for fails with "needs a file". The graduation navigate is worse: it
    // changes the composer's draft key, so the text the refusal just preserved
    // is replaced by the new key's empty draft.
    if (isNewSessionRoute) {
      // On /{slug}/new route — graduate: transition URL to /session/{id}, so a
      // /review sent from a fresh session doesn't leave the URL on .../new.
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
    // On /{slug}/new route — graduate: transition URL to /session/{id}
    if (isNewSessionRoute) {
      void navigate(`/session/${currentSessionId}`, { replace: true });
    }

    // planning#322 — first message of a session the Issues tab seeded from an
    // issue. Only the session it was seeded for may claim it: prefilling doesn't
    // pin the user to that session, and the ref must not follow them into an
    // unrelated one.
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
      // docs/218 — per-send opt-out for the auto-reset-merged-branch control.
      ...(resetMergedBranch !== undefined ? { resetMergedBranch } : {}),
      // docs/295 — and the compact-context control beside it (req 6).
      ...(compactContext !== undefined ? { compactContext } : {}),
      // docs/144 — tell the agent this message was spoken, not typed, so it
      // reads STT artifacts as artifacts. The bubble above stays verbatim.
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
        // The send was dropped — e.g. we just claimed a session on /{slug}/new
        // and the socket is still connecting. Dropping it here would leave the
        // user with an optimistic bubble + spinner and no response, so stash it
        // and let useConnectionSync flush it the moment the WS opens.
        // (docs/144 fix #2)
        //
        // The attempt-then-stash order matters: `status` is React state and can
        // lag the real readyState in both directions, so trusting it either
        // dropped a sendable frame or stashed one the socket would have taken.
        // `send`'s return value is the readyState itself.
        useSessionStore.getState().setPendingWsMessage(frame);
        return true;
      },
    });
    // Consumed: the ref belongs to the frame now (including the stashed-for-
    // reconnect case). Left in place on a dropped send so the retry still
    // carries it — `sendUserMessage` returns false only when nothing reached
    // the wire.
    if (issueRef && sent) useSessionStore.getState().setPendingIssueRef(undefined);
    // docs/293 req 4 — nothing reached the wire, so the composer keeps what it
    // would have sent. Not reachable today: the dispatch above stashes an
    // undeliverable frame for reconnect and reports success. Read anyway, so
    // that the clearing is tied to the send having happened rather than to
    // which dispatch this branch happens to be given.
    if (!sent) return false;
  } else {
    // No session — can't send without one (sessions are created via
    // claim-session). Still append the optimistic bubble so the user sees what
    // they typed, but DON'T flip isLoading: there's no agent to wait on.
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
  // The send went out (or, with no session, became a bubble that shows the user
  // exactly what it carried), so the composer may clear its chips.
  return true;
}
