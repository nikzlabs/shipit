import type { WsForkBreadcrumb } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleForkBreadcrumb: Handler<WsForkBreadcrumb> = (_ctx, data) => {
  const activeSessionId = useSessionStore.getState().sessionId;
  if (activeSessionId && data.parentSessionId !== activeSessionId) return;
  const childSessionId = data.message.forkChild?.childSessionId;
  useSessionStore.getState().setMessages((prev) =>
    childSessionId && prev.some((m) => m.forkChild?.childSessionId === childSessionId)
      ? prev
      : [...prev, data.message],
  );
};
