import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import type { WsEgressDecision } from "../../shared/types/ws-client-messages.js";
import { resolveRunner } from "./resolve-runner.js";
import { persistCardTransition } from "../chat-card-persistence.js";
import { allowEgressHost } from "../egress-policy.js";
import { EGRESS_GLOBAL_SCOPE } from "../egress-allowlist-store.js";
import type { PersistedEgressPrompt } from "../chat-history.js";
import { agentLogAppend } from "../log-emit.js";
import { applyEgressHostAdd } from "../services/settings-apply.js";

type EgressCtx = ConnectionCtx &
  RunnerCtx &
  Pick<AppCtx, "chatHistoryManager" | "egressAllowlistStore" | "containerManager" | "credentialStore">;

export async function handleEgressDecision(ctx: EgressCtx, msg: WsEgressDecision): Promise<void> {
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
  // "add" means the host was added to the durable list. A write that did not
  // land leaves the live grant in place and nothing else, so the card says
  // `allowed-once` — which is exactly what happened, rather than a promise the
  // next container start would break.
  let added = msg.action === "add";
  if (msg.action === "add") {
    // The card writes a GLOBAL host, so it goes through the shared layer for the
    // same three things the route gets — the built-in default is unsuppressed
    // rather than duplicated, the broadcast runs, and the write is serialized
    // against the Network tab writing the same list (docs/299 → Apply goes
    // through a shared layer). The live reload stays here and is the card's own:
    // a global add reloads nothing, but this one session's services must pick
    // the host up now, because the user granted it mid-turn.
    const store = ctx.egressAllowlistStore;
    if (store) {
      // Awaited, so the durable row is in place before the card is resolved:
      // the phase says the host was added, and it must not be able to say so
      // ahead of the write.
      const written = await applyEgressHostAdd(
        { sseBroadcast: ctx.sseBroadcast, egressAllowlistStore: store, credentialStore: ctx.credentialStore },
        EGRESS_GLOBAL_SCOPE,
        host,
      ).catch((error: unknown) => {
        console.error(`[egress:${sessionId}] adding ${host} from the prompt card failed:`, error);
        return null;
      });
      if (written?.outcome.status !== "applied") added = false;
    } else {
      added = false;
    }
    void ctx.containerManager?.reloadEgress(sessionId).catch((error: unknown) => {
      const message = `Allowlist saved, but running services were stopped because policy refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      ctx.broadcastLog("server", `[compose] Stack error: ${message}`);
      runner.emitMessage(agentLogAppend("server", `[compose] Stack error: ${message}`));
      runner.emitMessage({ type: "stack_error", sessionId, message });
    });
  }
  const phase: PersistedEgressPrompt["phase"] =
    msg.action === "deny" ? "denied" : added ? "added" : "allowed-once";

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
