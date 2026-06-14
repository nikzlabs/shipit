/**
 * WS handler for the Tier C egress allow-once card (docs/172, SHI-90).
 *
 * Fires when the user clicks Allow once / Add to allowlist / Deny on the inline
 * `EgressPromptCard`. The card itself was emitted over HTTP (the SNI proxy's
 * deny → the `/api/egress/decision` endpoint). This handler records the user's
 * decision in the per-session egress policy so the agent's retried connection is
 * allowed, then patches the card to its terminal phase (persisted) and echoes a
 * `egress_prompt_resolved`.
 *
 * Per the WS-lifecycle contract, we resolve the runner via the registry and emit
 * via `runner.emitMessage` so the result lands in the turn-event buffer and
 * survives reconnects.
 */

import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import type { WsEgressDecision } from "../../shared/types/ws-client-messages.js";
import { resolveRunner } from "./resolve-runner.js";
import { allowEgressHost } from "../egress-policy.js";
import type { PersistedEgressPrompt } from "../chat-history.js";

type EgressCtx = ConnectionCtx & RunnerCtx & Pick<AppCtx, "chatHistoryManager">;

export function handleEgressDecision(ctx: EgressCtx, msg: WsEgressDecision): void {
  const sessionId = ctx.getActiveAppSessionId();
  const runner = resolveRunner(ctx, sessionId);
  if (!sessionId || !runner) {
    ctx.send({ type: "error", message: "No active session for egress decision" });
    return;
  }
  const host = typeof msg.host === "string" ? msg.host.trim() : "";
  if (!host || !msg.cardId) {
    ctx.send({ type: "error", message: "egress decision requires host and cardId" });
    return;
  }

  // allow-once and add both grant the host for the session (durable persistence
  // of `add` is the Settings-UI follow-up). deny grants nothing.
  if (msg.action === "allow-once" || msg.action === "add") {
    allowEgressHost(sessionId, host);
  }
  const phase: PersistedEgressPrompt["phase"] =
    msg.action === "deny" ? "denied" : msg.action === "add" ? "added" : "allowed-once";

  ctx.chatHistoryManager.updateEgressPromptCard(sessionId, msg.cardId, { phase });
  runner.emitMessage({ type: "egress_prompt_resolved", sessionId, cardId: msg.cardId, phase });
}
