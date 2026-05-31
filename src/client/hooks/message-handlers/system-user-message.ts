import type { WsSystemUserMessage } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * Handle a `system_user_message` echo from a server-initiated turn.
 *
 * The server emits this for every dispatched turn (Fix CI, child spawn, and —
 * after docs/150 — the HTTP `agent/dispatch` route used by Create PR, Send
 * compose error, etc.). For HTTP-initiated dispatches the client has already
 * appended an optimistic user bubble tagged `pendingDispatch: true`; this
 * handler dedupes by clearing the flag in place instead of appending a
 * duplicate. For server-only dispatches (Fix CI), there is no optimistic
 * bubble to match and we append normally — both paths converge here.
 */
export const handleSystemUserMessage: Handler<WsSystemUserMessage> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.setMessages((prev) => {
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
      next[next.length - 1] = replaced;
      return next;
    }
    return [...prev, { role: "user" as const, text: data.text }];
  });
  session.setIsLoading(true);
  if (data.activity) {
    session.setActivity({ label: data.activity });
  }
};
