import type { WsModelInfo } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleModelInfo: Handler<WsModelInfo> = (_ctx, data) => {
  /**
   * `modelInfo` is a session-LESS global read by the dial for whichever session
   * is on screen, so a message naming another session must not be applied.
   *
   * Socket teardown is not the guarantee it looks like. `useMessageHandler`
   * drains the queue into a LOCAL array and dispatches the whole batch, so
   * clearing `messageQueueRef` and nulling `onmessage` cannot retract messages
   * already drained. A batch carrying `session_forked` (which moves the active
   * session mid-loop) followed by the parent's `model_info` then leaves the
   * parent's model and context window on the child's dial — with no later
   * writer to correct it until a turn starts.
   */
  if (data.sessionId !== useSessionStore.getState().sessionId) return;
  useUiStore.getState().setModelInfo({ model: data.model, contextWindowTokens: data.contextWindowTokens });
};
