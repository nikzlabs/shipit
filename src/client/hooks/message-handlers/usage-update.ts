import type { WsUsageUpdate } from "../../../server/shared/types.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleUsageUpdate: Handler<WsUsageUpdate> = (_ctx, data) => {
  // Every field this handler writes is a session-LESS global describing the
  // session on screen (`currentSessionUsage`, `contextTokens`, the cumulative
  // token pair) — so a message naming a DIFFERENT session must not be applied
  // (planning#482).
  //
  // The two disagree in a real window, not a hypothetical one: the per-session
  // socket is keyed off the ROUTE (`App`'s `wsSessionId`) while this handler
  // reads the STORE, and a switch moves the store first. The outgoing session's
  // trailing usage then landed on the incoming session — which for a session
  // with no turns of its own is the whole of what its dial reads, so a fresh
  // session opened straight after a long one showed the long one's fill.
  if (data.sessionId !== useSessionStore.getState().sessionId) return;
  const ui = useUiStore.getState();
  const update = data;
  ui.setCurrentSessionUsage({
    sessionId: update.sessionId,
    totals: update.totals,
    // docs/252 req 16 — carried live, so a turn does not blank the "by service"
    // split that `/history` hydrated.
    groups: update.groups,
    totalDurationMs: update.totalDurationMs,
    turnCount: update.turnCount,
  });
  // contextTokens reflects the *last turn's* context occupancy. The
  // `turn_usage_update` handler below sets the precise value (input +
  // cache reads + cache writes); this is just a coarse fallback for
  // sessions that don't emit per-turn data. `lastTurnInputTokens` alone
  // undercounts heavily when prompt caching is active, so prefer the
  // cumulative figure when that's all we have.
  //
  // A sub-agent consult (docs/144) is excluded: it contributes to the cost +
  // cumulative-token rollups below, but the context dial tracks the PINNED
  // agent's window — a one-shot consult must not move that needle.
  if (!update.subAgent) {
    if (update.cumulativeInputTokens !== undefined) {
      ui.setContextTokens(update.cumulativeInputTokens);
    } else if (update.lastTurnInputTokens !== undefined) {
      ui.setContextTokens(update.lastTurnInputTokens);
    }
  }
  ui.setCumulativeTokens(
    update.cumulativeInputTokens ?? 0,
    update.cumulativeOutputTokens ?? 0,
  );
};
