import type { WsPresentContentMessage } from "../../../server/shared/types.js";
import { usePresentStore } from "../../stores/present-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/093 — the agent emitted an artifact via the `present` MCP tool. Append
 * (or replace via `replaceId`) into the present-store; the AppLayout right
 * panel will surface the Present tab when the store gains its first entry.
 *
 * Discards messages from a previous session's WS connection — same guard the
 * preview-status handler uses for late-batched messages around session
 * switches.
 */
export const handlePresentContent: Handler<WsPresentContentMessage> = (_ctx, data) => {
  const currentSessionId = useSessionStore.getState().sessionId;
  if (data.sessionId && currentSessionId && data.sessionId !== currentSessionId) {
    return;
  }
  usePresentStore.getState().addOrReplace({
    presentId: data.presentId,
    content: data.content,
    mimeType: data.mimeType,
    createdAt: data.createdAt,
    ...(data.replaceId !== undefined ? { replaceId: data.replaceId } : {}),
    ...(data.title !== undefined ? { title: data.title } : {}),
  });
};
