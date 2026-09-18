import type { WsPermissionRequestCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { usePermissionStore } from "../../stores/permission-store.js";
import type { Handler } from "./types.js";

export const handlePermissionRequestCard: Handler<WsPermissionRequestCard> = (_ctx, data) => {
  usePermissionStore.getState().upsertCard({
    requestId: data.requestId,
    toolName: data.toolName,
    ...(data.path ? { path: data.path } : {}),
    ...(data.summary ? { summary: data.summary } : {}),
    ...(data.details ? { details: data.details } : {}),
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
