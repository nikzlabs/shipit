// A background subagent (`subagent` with `background: true`, verified on 2.2.5) returns a
// launch note at once, and `run` exits when the parent goes idle. Its report reaches the
// parent later as a `synthetic` message, after which the server resumes the parent itself.

import type { OpencodeEvent, OpencodeToolPart } from "../../../shared/opencode-stream.js";
import { unwrapOpencode2SubagentReport } from "./opencode2-tool-normalizer.js";
import type { Opencode2Message } from "./server.js";

/** The child session of a subagent call that is still running after it returned. */
export function backgroundSubagentSession(part: OpencodeToolPart): string | undefined {
  if (part.tool !== "subagent") return undefined;
  const meta = part.state?.metadata?.metadata;
  if (typeof meta !== "object" || meta === null) return undefined;
  const { status, sessionID } = meta as { status?: unknown; sessionID?: unknown };
  return status === "running" && typeof sessionID === "string" ? sessionID : undefined;
}

export interface SubagentNotice {
  childSessionId: string;
  /** The status `agent_self_wake` carries. */
  status: "completed" | "failed" | "stopped";
  report: string;
}

export function subagentNotice(message: Opencode2Message): SubagentNotice | undefined {
  if (message.type !== "synthetic" || message.metadata?.source !== "subagent") return undefined;
  const childSessionId = message.metadata.childID;
  if (typeof childSessionId !== "string") return undefined;
  const state = message.metadata.state;
  const status = state === "completed" ? "completed" : state === "error" ? "failed" : "stopped";
  return { childSessionId, status, report: unwrapOpencode2SubagentReport(message.text ?? "") };
}

function contentText(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
      return type === "text" && typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

/** A finished assistant message as the lines `run --format json` prints for it. */
export function messageRunEvents(sessionId: string, message: Opencode2Message): OpencodeEvent[] {
  const messageID = message.id;
  const events: OpencodeEvent[] = [];
  for (const part of message.content ?? []) {
    if (part.type === "text" && part.text) {
      events.push({ type: "text", sessionID: sessionId, part: { id: part.id, messageID, type: "text", text: part.text } });
      continue;
    }
    const status = part.state?.status;
    if (part.type !== "tool" || (status !== "completed" && status !== "error")) continue;
    const state = part.state ?? {};
    events.push({
      type: "tool_use",
      sessionID: sessionId,
      part: {
        id: part.id,
        messageID,
        type: "tool",
        tool: part.name,
        state: {
          status,
          input: state.input,
          ...(status === "error" ? { error: state.error?.message ?? "" } : { output: contentText(state.content) }),
          metadata: { metadata: state.metadata, content: state.content },
        },
      },
    });
  }
  if (message.error) events.push({ type: "error", sessionID: sessionId, error: message.error });
  events.push({
    type: "step_finish",
    sessionID: sessionId,
    part: { messageID, type: "step-finish", reason: message.finish, tokens: message.tokens, cost: message.cost },
  });
  return events;
}
