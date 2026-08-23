import type { WsSystemUserMessage } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * Handle a `system_user_message` echo — the user message a starting turn is
 * answering, broadcast to every attached viewer.
 *
 * The server emits this for every dispatched turn (Fix CI, child spawn, and —
 * after docs/150 — the HTTP `agent/dispatch` route used by Create PR, Send
 * compose error, etc.). For HTTP-initiated dispatches the client has already
 * appended an optimistic user bubble tagged `pendingDispatch: true`; this
 * handler dedupes by clearing the flag in place instead of appending a
 * duplicate. For server-only dispatches (Fix CI), there is no optimistic
 * bubble to match and we append normally — both paths converge here.
 *
 * It is also emitted for a user-typed WS message, carrying that send's
 * `clientRequestId`. On the SENDING tab that id matches the optimistic bubble
 * and we no-op; on every other viewer nothing matches and the message finally
 * appears, instead of the tab showing an agent reply to a message it never
 * rendered until the next reload.
 *
 * The id is checked before the text comparison below, and is the only reliable
 * key for a typed message: repeated one-word sends ("continue", "yes") are
 * genuinely distinct messages that text matching would collapse into one.
 */
export const handleSystemUserMessage: Handler<WsSystemUserMessage> = (_ctx, data) => {
  const session = useSessionStore.getState();
  const echoedRequestId = data.clientRequestId;
  if (echoedRequestId !== undefined
    && session.messages.some((m) => m.clientRequestId === echoedRequestId)) {
    // This tab is the sender — its optimistic bubble already carries the text,
    // the attachments and the exact position. Nothing to add.
    session.setIsLoading(true);
    if (data.activity) session.setActivity({ label: data.activity });
    return;
  }
  const appended = {
    role: "user" as const,
    text: data.text,
    ...(data.agentInterface ? { agentInterface: data.agentInterface } : {}),
    ...(data.messageOrigin ? { messageOrigin: data.messageOrigin } : {}),
    ...(data.images ? { images: data.images } : {}),
    ...(data.files ? { files: data.files } : {}),
    ...(data.uploadPaths ? { uploadPaths: data.uploadPaths } : {}),
  };
  session.setMessages((prev) => {
    // A typed message that got this far belongs to a DIFFERENT viewer than the
    // sender, so it is always new — skip the text comparison, which cannot tell
    // a second "continue" from the first.
    if (echoedRequestId !== undefined) return [...prev, appended];
    const tail = prev[prev.length - 1];
    if (tail?.role === "user" && tail.text === data.text) {
      const next = prev.slice();
      // Replace the tail bubble with a copy that drops `pendingDispatch` so a
      // later identical-text dispatch can still be deduped against its own
      // optimistic append, not this one. The broader same-tail dedupe also
      // covers queued/replayed system turns where HTTP history or
      // queue_updated already restored the user bubble before the replayed
      // system_user_message arrives.
      const replaced = { ...tail };
      delete replaced.pendingDispatch;
      if (data.agentInterface) replaced.agentInterface = data.agentInterface;
      if (data.messageOrigin) replaced.messageOrigin = data.messageOrigin;
      next[next.length - 1] = replaced;
      return next;
    }
    return [...prev, appended];
  });
  session.setIsLoading(true);
  if (data.activity) {
    session.setActivity({ label: data.activity });
  }
};
