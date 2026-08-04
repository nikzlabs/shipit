import type { WsSubagentReportUpdate } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/109 reqs 10–11 — a backgrounded subagent finished, and the server has
 * replaced its launch acknowledgement with what it reported. Swap the tool
 * result in the loaded transcript so the card retires live instead of only on
 * the next reload.
 *
 * No card state is set and no component knows about this message: once the
 * content is a real report, `isBackgroundLaunchAck` stops matching and
 * `SubagentCall`/`SubagentReport` render it exactly as they render any other
 * final report — badge, panel, chips, clamp, modal.
 *
 * Idempotent, and safely so on a replay: the server's own guard only rewrites a
 * result that still IS the acknowledgement, so a second delivery carries the
 * same content, and applying it twice is a no-op. A message with no matching
 * result (the row was rewound away, or this viewer has a different session
 * loaded) is left untouched — the persisted row is the source of truth and a
 * reload picks it up.
 */
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
