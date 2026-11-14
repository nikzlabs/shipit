import type { AgentMergeClaimStore } from "../agent-merge-claims.js";

/**
 * docs/343-agent-merge-cancel-notice — a request that ends without a merge is told to the agent
 * through its inbox, which carries it on the next prompt until read and starts an idle session.
 */
export function agentMergeEndedBody(prNumber: number, reason: string): string {
  return `[ShipIt] Your merge request for pull request #${prNumber} (\`gh pr merge --auto\`) ended `
    + `without a merge. ${reason} The request is gone: fix the cause if there is one, and run `
    + `\`gh pr merge ${prNumber} --auto\` again if the pull request should still merge.`;
}

/**
 * Synchronous, so it can run inside the transaction that ends the request: a store that throws
 * rolls the ending back. Returns whether it stored, so the caller tells the inbox only then.
 */
export function storeAgentMergeEnded(
  claims: Pick<AgentMergeClaimStore, "agentInbox">,
  sessionId: string,
  prNumber: number,
  reason: string,
): boolean {
  const inbox = claims.agentInbox;
  if (!inbox) return false;
  inbox.add(sessionId, { body: agentMergeEndedBody(prNumber, reason) });
  return true;
}

/** Never throws: the message is stored, and the inbox sweep tells for a call that fails. */
export function tellAgentMergeEnded(claims: Pick<AgentMergeClaimStore, "agentInbox">, sessionId: string): void {
  const inbox = claims.agentInbox;
  if (!inbox) return;
  void inbox.tell(sessionId).catch((err: unknown) => {
    console.error(`[agent-merge] telling ${sessionId} about its ended merge request failed:`, err);
  });
}

