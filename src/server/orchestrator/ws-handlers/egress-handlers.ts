import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import type { WsEgressDecision } from "../../shared/types/ws-client-messages.js";
import { resolveRunner } from "./resolve-runner.js";
import { persistCardTransition } from "../chat-card-persistence.js";
import { allowEgressHost } from "../egress-policy.js";
import { EGRESS_GLOBAL_SCOPE } from "../egress-allowlist-store.js";
import type { PersistedEgressPrompt } from "../chat-history.js";
import { agentLogAppend } from "../log-emit.js";

type EgressCtx = ConnectionCtx &
  RunnerCtx &
  Pick<AppCtx, "chatHistoryManager" | "egressAllowlistStore" | "containerManager">;

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

  if (msg.action === "allow-once" || msg.action === "add") {
    allowEgressHost(sessionId, host);
  }
  if (msg.action === "add") {
    ctx.egressAllowlistStore?.addHost(EGRESS_GLOBAL_SCOPE, host);
    void ctx.containerManager?.reloadEgress(sessionId).catch((error: unknown) => {
      const message = `Allowlist saved, but running services were stopped because policy refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      ctx.broadcastLog("server", `[compose] Stack error: ${message}`);
      runner.emitMessage(agentLogAppend("server", `[compose] Stack error: ${message}`));
      runner.emitMessage({ type: "stack_error", sessionId, message });
    });
  }
  const phase: PersistedEgressPrompt["phase"] =
    msg.action === "deny" ? "denied" : msg.action === "add" ? "added" : "allowed-once";

  // Update recorded cards too, so turn finalization cannot restore the pending phase.
  persistCardTransition(
    runner,
    { chatHistoryManager: ctx.chatHistoryManager, sessionId },
    (m) => m.egressPrompt?.cardId === msg.cardId,
    (m) => ({ ...m, egressPrompt: { ...m.egressPrompt!, phase } }),
    () => ctx.chatHistoryManager.updateEgressPromptCard(sessionId, msg.cardId, { phase }),
  );
  runner.emitMessage({ type: "egress_prompt_resolved", sessionId, cardId: msg.cardId, phase });
}
