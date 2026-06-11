import type { WsPermissionRequestCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { usePermissionStore } from "../../stores/permission-store.js";
import type { Handler } from "./types.js";

/**
 * docs/193 / SHI-112 — the inline permission-request card. Seed the payload into
 * the permission store (keyed by requestId so a later resolved update can swap
 * it in place) and append a marker chat message so it renders inline where the
 * agent's action was gated.
 *
 * Idempotent by requestId: the card is both persisted to chat history and
 * buffered into the turn-event log, so a reconnect can deliver it twice (once
 * from `loadSessionHistory`, once from the buffer replay). Skip the duplicate
 * append when a card with this id is already present; `upsertCard` is itself
 * non-clobbering so it can't reset a card already rehydrated as resolved.
 */
export const handlePermissionRequestCard: Handler<WsPermissionRequestCard> = (_ctx, data) => {
  usePermissionStore.getState().upsertCard({
    requestId: data.requestId,
    toolName: data.toolName,
    ...(data.path ? { path: data.path } : {}),
    ...(data.summary ? { summary: data.summary } : {}),
    ...(data.agentId ? { agentId: data.agentId } : {}),
    ...(data.createdAt ? { createdAt: data.createdAt } : {}),
  });

  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.permissionPrompt?.requestId === data.requestId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.permissionPrompt?.requestId === data.requestId)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            permissionPrompt: { requestId: data.requestId },
          },
        ],
  );
};
