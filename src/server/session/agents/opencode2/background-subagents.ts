// A background subagent (`subagent` with `background: true`, verified on 2.2.5) returns a
// launch note at once, and `run` exits when the parent goes idle. Its report reaches the
// parent later as a `synthetic` message, after which the server resumes the parent itself.

import type { OpencodeEvent, OpencodeToolPart } from "../../../shared/opencode-stream.js";
import { unwrapOpencode2SubagentReport } from "./opencode2-tool-normalizer.js";
import type { Opencode2Message, Opencode2MessagePart } from "./server.js";

function subagentMeta(part: OpencodeToolPart): { status?: unknown; sessionID?: unknown } | undefined {
  if (part.tool !== "subagent") return undefined;
  const meta = part.state?.metadata?.metadata;
  return typeof meta === "object" && meta !== null ? meta : undefined;
}

/** The child session a subagent call ran in. */
export function subagentSession(part: OpencodeToolPart): string | undefined {
  const sessionID = subagentMeta(part)?.sessionID;
  return typeof sessionID === "string" ? sessionID : undefined;
}

/** The child session of a subagent call that is still running after it returned. */
export function backgroundSubagentSession(part: OpencodeToolPart): string | undefined {
  return subagentMeta(part)?.status === "running" ? subagentSession(part) : undefined;
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

/** A listed tool part in the shape `run --format json` prints, whatever its status. */
export function listedToolPart(part: Opencode2MessagePart): (OpencodeToolPart & { id: string }) | undefined {
  if (part.type !== "tool" || !part.id) return undefined;
  const state = part.state ?? {};
  const status = state.status;
  return {
    id: part.id,
    type: "tool",
    tool: part.name,
    state: {
      status,
      input: state.input,
      ...(status === "error" ? { error: state.error?.message ?? "" } : { output: contentText(state.content) }),
      metadata: { metadata: state.metadata, content: state.content },
    },
  };
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
    const tool = listedToolPart(part);
    if (tool && (tool.state?.status === "completed" || tool.state?.status === "error")) {
      events.push({ type: "tool_use", sessionID: sessionId, part: { ...tool, messageID } });
    }
  }
  if (message.error) events.push({ type: "error", sessionID: sessionId, error: message.error });
  events.push({
    type: "step_finish",
    sessionID: sessionId,
    part: { messageID, type: "step-finish", reason: message.finish, tokens: message.tokens, cost: message.cost },
  });
  return events;
}
