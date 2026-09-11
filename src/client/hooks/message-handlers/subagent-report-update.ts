import type { WsSubagentReportUpdate } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleSubagentReportUpdate: Handler<WsSubagentReportUpdate> = (_ctx, data) => {
  useSessionStore.getState().setMessages((prev) => {
    const idx = prev.findIndex((m) => m.toolResults?.some((r) => r.toolUseId === data.toolUseId));
    if (idx < 0) return prev;
    const next = prev.slice();
    next[idx] = {
      ...next[idx],
      toolResults: next[idx].toolResults?.map((r) =>
        r.toolUseId === data.toolUseId ? { ...r, ...data.result } : r,
      ),
    };
    return next;
  });
};
