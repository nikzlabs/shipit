import type { WsPresentStateMessage } from "../../../server/shared/types.js";
import { usePresentStore } from "../../stores/present-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/093 — full presentation snapshot replayed by the orchestrator on viewer
 * attach. Hydrates the present-store from the runner's authoritative cache so
 * the Present tab survives session switches and late tab opens (the live
 * `present_content` stream may have already passed).
 *
 * Silent sync: unlike `present_content`, hydration does NOT bump the unseen
 * badge or auto-switch the right panel. Same stale-session guard as the other
 * present handlers.
 */
export const handlePresentState: Handler<WsPresentStateMessage> = (_ctx, data) => {
  const currentSessionId = useSessionStore.getState().sessionId;
  if (data.sessionId && currentSessionId && data.sessionId !== currentSessionId) {
    return;
  }
  usePresentStore.getState().hydrate(
    data.presentations.map((p) => ({
      presentId: p.presentId,
      content: p.content,
      mimeType: p.mimeType,
      createdAt: p.createdAt,
      ...(p.title !== undefined ? { title: p.title } : {}),
    })),
  );
};
