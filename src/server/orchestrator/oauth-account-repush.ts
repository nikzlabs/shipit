import type { AgentId, SessionInfo } from "../shared/types.js";
import {
  readSessionAccountMarker,
  repushAgentToken,
  repushProviderAccountToken,
} from "./session-credentials.js";

export interface OAuthAccountRepushDeps {
  credentialsDir: string;
  listSessions: () => readonly Pick<SessionInfo, "id" | "agentId" | "agentPinned">[];
  hasLiveAgent: (sessionId: string) => boolean;
}

export function createOAuthAccountRepush(
  deps: OAuthAccountRepushDeps,
  logPrefix: string,
): (agentId: AgentId, accountId: string) => void {
  return (agentId, accountId) => {
    const pinned = deps.listSessions()
      .filter((session) => session.agentPinned && session.agentId === agentId)
      .map((session) => ({ id: session.id, live: deps.hasLiveAgent(session.id) }));
    // A live CLI's next request can fail until it has the new token; an idle one reads it at its
    // next turn. Each push costs a recursive chown, so the live ones go first (docs/153).
    pinned.sort((a, b) => Number(b.live) - Number(a.live));
    let healed = 0;
    for (const session of pinned) {
      // Use the credential subtree's account marker; routing may have changed.
      const marked = readSessionAccountMarker(deps.credentialsDir, session.id)[agentId];
      if (marked !== undefined && marked !== accountId) continue;
      try {
        // Credential repair unlinks files and would interrupt a live CLI.
        const opts = { repairLeakedSubtrees: !deps.hasLiveAgent(session.id) };
        const wrote =
          marked !== undefined
            ? repushProviderAccountToken(deps.credentialsDir, session.id, agentId, accountId, opts)
            : repushAgentToken(deps.credentialsDir, session.id, agentId, opts);
        if (wrote) healed++;
      } catch (err) {
        console.error(`[${logPrefix}] repush failed for session ${session.id}:`, err);
      }
    }
    if (healed > 0) {
      console.log(`[${logPrefix}] propagated refreshed ${agentId}/${accountId} token to ${healed} pinned session(s)`);
    }
  };
}
