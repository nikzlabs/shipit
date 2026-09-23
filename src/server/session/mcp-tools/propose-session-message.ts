import type { ToolDescriptor } from "./types.js";
import {
  validateSessionMessageProposal,
  MAX_PROPOSED_MESSAGE_LEN,
  MAX_TARGET_SESSION_ID_LEN,
} from "../../shared/session-message-proposal-validation.js";

const TOOL_DESCRIPTION = [
  "Propose a message for a session you cannot address, as a card the user",
  "approves with one click. `shipit session message` reaches only the sessions",
  "YOU spawned; every other session on this host — the one that spawned the",
  "prompt you are working from, a sibling, an unrelated session — is",
  "unreachable, and this is the way to reach it. Use it when you have been",
  "asked to report a result back to a session you cannot message. ShipIt checks",
  "the session id when you call, so you find out now rather than the user",
  "finding out on the click. Approval delivers this one message and nothing",
  "more: it starts a turn there, it grants you no further access, and you will",
  "not hear back — put everything the reader needs in the message. A session",
  "you spawned is NOT a target; message it directly.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    sessionId: {
      type: "string",
      maxLength: MAX_TARGET_SESSION_ID_LEN,
      description:
        "The id of the session the message should reach. It comes from the prompt you were given — "
        + "ShipIt has no way to list the sessions on this host.",
    },
    message: {
      type: "string",
      maxLength: MAX_PROPOSED_MESSAGE_LEN,
      description:
        `The text that session would receive — at most ${MAX_PROPOSED_MESSAGE_LEN} characters. The user `
        + "reads it in full before approving it, so summarize rather than paste. It must also stand on "
        + "its own: the agent reading it has none of this conversation and a different workspace. Say "
        + "which session the message is from and what it is answering.",
    },
  },
  required: ["sessionId", "message"],
};

const INSTRUCTIONS = [
  "When you need to reach a session `shipit session message` cannot address —",
  "the session that wrote the prompt you are working from, a sibling, any",
  "session you did not spawn — propose the message with",
  "`propose_session_message` instead of printing it in chat for the user to",
  "carry across. One click delivers it there. The message must be",
  "self-contained: the session that receives it has none of this conversation.",
].join(" ");

export const proposeSessionMessageTool: ToolDescriptor = {
  id: "propose_session_message",
  name: "propose_session_message",
  description: TOOL_DESCRIPTION,
  inputSchema,
  instructions: INSTRUCTIONS,
  async call(args, { workerUrl }) {
    const a = args as { sessionId?: unknown; message?: unknown };

    const pre = validateSessionMessageProposal(a);
    if ("error" in pre) {
      return {
        content: [{ type: "text", text: `propose_session_message failed: ${pre.error}` }],
        isError: true,
      };
    }

    try {
      const res = await fetch(`${workerUrl}/agent-ops/propose-session-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pre),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        targetTitle?: string;
      };
      if (!res.ok) {
        const reason = body.error || `propose_session_message service returned HTTP ${res.status}`;
        return {
          content: [{ type: "text", text: `propose_session_message failed: ${reason}` }],
          isError: true,
        };
      }
      const target = body.targetTitle ?? pre.sessionId;
      return {
        content: [
          {
            type: "text",
            text:
              `Posted a card proposing a message to ${target}. `
              + "The user approves it with one click, and it is delivered once — you will not hear "
              + "back, and you cannot send another without proposing another card. Do not repeat the "
              + "message in prose; end your turn.",
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: `propose_session_message could not reach the worker: ${message}` },
        ],
        isError: true,
      };
    }
  },
};
