import type { WsSessionForked } from "../../../server/shared/types.js";
import { resumeSessionInternal } from "../../stores/actions/session-actions.js";
import type { Handler } from "./types.js";

export const handleSessionForked: Handler<WsSessionForked> = (_ctx, data) => {
  const childSessionId = data.childSessionId ?? data.sessionId;
  if (!childSessionId) return;

  /**
   * Adopt the child through the ordinary switch path (docs/144 D7 — "client
   * auto-switches to the child"), not a bare `setSessionId`.
   *
   * The bare set moved the store id first, so the route effect in
   * `useSessionActivation` found `urlSessionId === sessionId` and skipped
   * `resumeSessionInternal` entirely — the child inherited the parent's whole
   * session-scoped UI state. The dial's globals were the visible part: a fresh
   * fork has no usage row, and `loadSessionHistory` only replaces `modelInfo`
   * when a turn recorded a model, so the parent's model, context window and
   * spend stayed on screen.
   */
  resumeSessionInternal(childSessionId);
  window.history.pushState({}, "", `/session/${childSessionId}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
};
