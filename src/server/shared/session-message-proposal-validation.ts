/**
 * docs/314 — field validation for `propose_session_message`, shared by the MCP
 * tool and the orchestrator route so the two cannot disagree about what is
 * accepted. Resolving the target session lives in the route; only shapes and
 * lengths are checked here.
 */

export const MAX_TARGET_SESSION_ID_LEN = 200;
export const MAX_PROPOSED_MESSAGE_LEN = 4000;

export interface ValidatedSessionMessageProposal {
  sessionId: string;
  message: string;
}

// JSON Schema maxLength counts code points, not UTF-16 units.
function charLength(s: string): number {
  return /[\uD800-\uDBFF]/.test(s) ? Array.from(s).length : s.length;
}

function field(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  return typeof v === "string" ? v.trim() : "";
}

export function validateSessionMessageProposal(body: {
  sessionId?: unknown;
  message?: unknown;
}): ValidatedSessionMessageProposal | { error: string } {
  const raw = body as Record<string, unknown>;

  const sessionId = field(raw, "sessionId");
  if (!sessionId) {
    return {
      error:
        "`sessionId` is required — the id of the session the message should reach. "
        + "It comes from the prompt you were given; ShipIt has no way to list the sessions on this host.",
    };
  }
  if (charLength(sessionId) > MAX_TARGET_SESSION_ID_LEN) {
    return { error: `\`sessionId\` is ${charLength(sessionId)} characters; the cap is ${MAX_TARGET_SESSION_ID_LEN}.` };
  }
  if (/\s/.test(sessionId)) {
    return { error: "`sessionId` contains whitespace; pass the session id on its own." };
  }

  const message = field(raw, "message");
  if (!message) {
    return { error: "`message` is required — the text the target session would receive." };
  }
  if (charLength(message) > MAX_PROPOSED_MESSAGE_LEN) {
    return {
      error:
        `\`message\` is ${charLength(message)} characters; the cap is ${MAX_PROPOSED_MESSAGE_LEN}. `
        + "The user reads this text in full before approving it, so summarize rather than paste.",
    };
  }

  return { sessionId, message };
}
