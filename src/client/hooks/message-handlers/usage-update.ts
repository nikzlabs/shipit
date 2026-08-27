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
  // This message deliberately does NOT touch `contextTokens` (planning#482).
  //
  // That field means "how much of the window the session occupies NOW", and
  // nothing on this message measures it. It used to be written from
  // `cumulativeInputTokens` — the session's LIFETIME sum of input tokens, which
  // only grows — falling back to `lastTurnInputTokens`, the uncached portion of
  // one turn's prompt, which under prompt caching is near zero. One overstates
  // without bound, the other undercounts heavily; neither is an occupancy.
  //
  // The authoritative reading is `turn_usage_update.turn`, and every
  // `usage_update` the agent path emits is emitted alongside one
  // (`agent-listeners.ts` — both live inside the same `if (perTurnUsage)`), so
  // the coarse value was at best overwritten a moment later and at worst left
  // standing: a turn that reports no token telemetry (a Codex compact result)
  // gets no per-turn row, so the dial was pinned to a lifetime sum precisely
  // when a compaction had just FREED context. The sub-agent consult that emits
  // this message on its own (docs/144) never had a reading to contribute
  // either. Keeping the last real occupancy is the honest answer in all three
  // cases.
  ui.setCumulativeTokens(
    update.cumulativeInputTokens ?? 0,
    update.cumulativeOutputTokens ?? 0,
  );
};
