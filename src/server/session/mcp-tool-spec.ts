import type { AgentMcpWriteContext } from "../shared/types.js";

const OFFER_TOOL = "propose_actions";
const STATUS_TOOL = "session_status";

/**
 * docs/303 req 21 — while the session status card is on, the card IS how the
 * agent offers actions, and `propose_actions` is absent from its context rather
 * than present and refused. Each adapter keeps its own tool order; this swaps
 * the one id, so the flag-off spec stays byte for byte what it was.
 */
export function shipitToolSpec(
  spec: string,
  ctx: Pick<AgentMcpWriteContext, "sessionStatusCard">,
): string {
  if (!ctx.sessionStatusCard) return spec;
  return spec.replace(OFFER_TOOL, STATUS_TOOL);
}
