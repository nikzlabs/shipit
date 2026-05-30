import type { WsPresentContentMessage } from "../../../server/shared/types.js";
import { usePresentStore } from "../../stores/present-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

/**
 * docs/093 — the agent emitted an artifact via the `present` MCP tool. Append
 * (or replace via `replaceId`) into the present-store; the AppLayout right
 * panel will surface the Present tab when the store gains its first entry.
 *
 * Discards messages from a previous session's WS connection — same guard the
 * preview-status handler uses for late-batched messages around session
 * switches.
 *
 * Auto-switch lives here (not an App-level effect on `presentations.length`)
 * so it fires ONLY on a live arrival. The `present_state` hydrate replay also
 * grows the list, and we must not yank the user's right-panel focus on a
 * silent state sync after a session switch.
 */
export const handlePresentContent: Handler<WsPresentContentMessage> = (_ctx, data) => {
  const currentSessionId = useSessionStore.getState().sessionId;
  if (data.sessionId && currentSessionId && data.sessionId !== currentSessionId) {
    return;
  }
  const before = usePresentStore.getState().presentations.length;
  usePresentStore.getState().addOrReplace({
    presentId: data.presentId,
    content: data.content,
    mimeType: data.mimeType,
    createdAt: data.createdAt,
    ...(data.replaceId !== undefined ? { replaceId: data.replaceId } : {}),
    ...(data.title !== undefined ? { title: data.title } : {}),
  });
  const after = usePresentStore.getState().presentations.length;
  // First presentation to land in this session — surface the tab once. After
  // the user manually moves away we don't pull them back (only the 0→1 edge
  // triggers).
  if (before === 0 && after === 1 && useUiStore.getState().rightTab !== "present") {
    useUiStore.getState().setRightTab("present");
    usePresentStore.getState().markSeen();
  }
};
