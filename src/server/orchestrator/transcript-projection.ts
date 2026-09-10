// Project only browser payloads. Persist the original bodies; fromRow also feeds writes.
import { createHash } from "node:crypto";
import {
  sliceBody,
  subAgentPreviewLine,
  RESULT_STRIP_FLOOR_BYTES,
} from "../shared/transcript-slice.js";
import {
  shipsResultBodyWhole,
  rendersResultContentInline,
  SUBAGENT_REPORT_TOOL_NAMES,
} from "../shared/transcript-slice-tools.js";
import { sliceSubagentReport } from "../shared/subagent-report.js";
import {
  COMMAND_SUMMARY_CHARS,
  INPUT_STRIP_FLOOR_BYTES,
  inputKeyTreatment,
} from "../shared/transcript-input-policy.js";
import type { PersistedMessage } from "./chat-history.js";
import type { AgentEvent, SubAgentConsultCard } from "../shared/types.js";
import type { ToolResultEntry } from "./session-runner.js";

const DIFF_INPUT_TOOLS = new Set(["Edit", "Write"]);
const DIFF_BODY_KEYS = ["content", "old_string", "new_string"] as const;

export function imageUrl(sessionId: string, hash: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/images/${hash}`;
}

export function imageHash(base64: string): string {
  return createHash("sha256").update(base64).digest("hex");
}

function countLines(text: string): number {
  if (!text) return 0;
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized ? normalized.split("\n").length : 0;
}

export function substituteResultImages(sessionId: string, content: string): string {
  const projected = projectBlockArray(sessionId, content, "keep");
  return projected ? projected.content : content;
}

// Slice block text, not serialized JSON, so image results remain parseable.
function projectBlockArray(
  sessionId: string,
  content: string,
  mode: "keep" | "slice" | "empty",
): { content: string; sliced: ReturnType<typeof sliceBody> } | null {
  if (!content.startsWith("[")) return null;
  let blocks: unknown;
  try {
    blocks = JSON.parse(content);
  } catch {
    return null;
  }
  if (!Array.isArray(blocks)) return null;

  const texts: string[] = [];
  let sawImage = false;
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    if (b.type === "image") sawImage = true;
  }
  if (!sawImage) return null;

  const joined = texts.join("\n");
  // Below the floor, truncation metadata costs more than the text it replaces.
  const belowFloor = Buffer.byteLength(joined, "utf8") <= RESULT_STRIP_FLOOR_BYTES;
  const sliced = mode === "keep" || !joined || belowFloor
    ? null
    : mode === "empty"
      ? { content: "", totalLines: countLines(joined), totalBytes: Buffer.byteLength(joined, "utf8") }
      : sliceBody(joined);
  const text = sliced ? sliced.content : joined;

  let textEmitted = false;
  const rewritten: unknown[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) {
      rewritten.push(block);
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === "text") {
      // Keep the separate final block that identifies a report's accounting footer.
      if (mode === "keep") {
        rewritten.push(block);
        continue;
      }
      if (textEmitted) continue;
      textEmitted = true;
      rewritten.push({ ...b, text });
      continue;
    }
    if (b.type === "image") {
      const source = b.source as Record<string, unknown> | undefined;
      if (source && typeof source.data === "string" && source.data) {
        const { data, ...rest } = source;
        rewritten.push({ ...b, source: { ...rest, shipit_url: imageUrl(sessionId, imageHash(data)) } });
        continue;
      }
    }
    rewritten.push(block);
  }

  return { content: JSON.stringify(rewritten), sliced };
}

export function projectToolResult(
  sessionId: string,
  result: ToolResultEntry,
  toolName: string | undefined,
): ToolResultEntry {
  const exempt = shipsResultBodyWhole(toolName);

  // Report slicing preserves its footer but does not remove base64 images.
  if (toolName && SUBAGENT_REPORT_TOOL_NAMES.has(toolName)) {
    const withUrls = substituteResultImages(sessionId, result.content);
    const sliced = sliceSubagentReport(withUrls);
    if (!sliced) {
      return withUrls === result.content ? result : { ...result, content: withUrls };
    }
    return {
      ...result,
      content: sliced.content,
      truncated: true,
      totalLines: sliced.totalLines,
      totalBytes: sliced.totalBytes,
    };
  }

  if (!exempt && !rendersResultContentInline(toolName)) {
    const blocks = projectBlockArray(sessionId, result.content, "empty");
    if (blocks) {
      if (!blocks.sliced) {
        return blocks.content === result.content ? result : { ...result, content: blocks.content };
      }
      return {
        ...result,
        content: blocks.content,
        truncated: true,
        totalLines: blocks.sliced.totalLines,
        totalBytes: blocks.sliced.totalBytes,
      };
    }
    if (Buffer.byteLength(result.content, "utf8") <= RESULT_STRIP_FLOOR_BYTES) return result;
    return {
      ...result,
      content: "",
      truncated: true,
      totalLines: countLines(result.content),
      totalBytes: Buffer.byteLength(result.content, "utf8"),
    };
  }

  const blocks = projectBlockArray(sessionId, result.content, exempt ? "keep" : "slice");
  if (blocks) {
    if (exempt || !blocks.sliced) {
      return blocks.content === result.content ? result : { ...result, content: blocks.content };
    }
    return {
      ...result,
      content: blocks.content,
      truncated: true,
      totalLines: blocks.sliced.totalLines,
      totalBytes: blocks.sliced.totalBytes,
    };
  }

  if (exempt) return result;

  const sliced = sliceBody(result.content);
  if (!sliced) return result;
  return {
    ...result,
    content: sliced.content,
    truncated: true,
    totalLines: sliced.totalLines,
    totalBytes: sliced.totalBytes,
  };
}

function inputValueBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (value === undefined || value === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

function shouldProjectInput(tool: { name: string; input: Record<string, unknown> }, key: string): boolean {
  if (inputKeyTreatment(tool.name, key, tool.input) === "keep") return false;
  return inputValueBytes(tool.input[key]) > INPUT_STRIP_FLOOR_BYTES;
}

// Match DiffBlock's line counts before removing the bodies used to calculate them.
function diffStatsFor(tool: { name: string; input: Record<string, unknown> }): { added: number; removed: number } | undefined {
  if (!DIFF_INPUT_TOOLS.has(tool.name)) return undefined;
  const str = (key: string): string => (typeof tool.input[key] === "string" ? tool.input[key] : "");
  if (!DIFF_BODY_KEYS.some((k) => str(k).length > 0)) return undefined;
  return {
    added: countLines(str("new_string") || str("content")),
    removed: countLines(str("old_string")),
  };
}

export function projectToolUse<T extends { name: string; input: Record<string, unknown> }>(
  tool: T,
): T & { bodyTruncated?: true; diffStats?: { added: number; removed: number }; inputChars?: Record<string, number> } {
  const keys = Object.keys(tool.input);
  if (!keys.some((k) => shouldProjectInput(tool, k))) return tool;

  const input: Record<string, unknown> = {};
  const inputChars: Record<string, number> = {};
  for (const key of keys) {
    const value = tool.input[key];
    if (!shouldProjectInput(tool, key)) {
      input[key] = value;
      continue;
    }
    if (typeof value === "string") {
      inputChars[key] = value.length;
      if (inputKeyTreatment(tool.name, key, tool.input) === "head") {
        input[key] = value.slice(0, COMMAND_SUMMARY_CHARS);
      }
    }
  }

  const diffStats = diffStatsFor(tool);
  return {
    ...tool,
    input,
    bodyTruncated: true,
    ...(diffStats ? { diffStats } : {}),
    ...(Object.keys(inputChars).length > 0 ? { inputChars } : {}),
  };
}

export function projectConsultCardForWire(card: SubAgentConsultCard): SubAgentConsultCard {
  const output = card.outputMarkdown;
  if (!output) return card;
  if (Buffer.byteLength(output, "utf8") <= RESULT_STRIP_FLOOR_BYTES) return card;
  const preview = subAgentPreviewLine(output);
  if (preview === output) return card;
  return { ...card, outputMarkdown: preview, outputTruncated: true };
}

// Groups mutate after persistence. Track bodies by ID, with separate input/result commits.
export interface CommittedBodyIds {
  toolInputs: Set<string>;
  toolResults: Set<string>;
}

export function createCommittedBodyIds(): CommittedBodyIds {
  return { toolInputs: new Set(), toolResults: new Set() };
}

export function clearCommittedBodyIds(ids: CommittedBodyIds): void {
  ids.toolInputs.clear();
  ids.toolResults.clear();
}

// Pass the exact messages successfully written by replaceInProgress.
export function markMessagesCommitted(ids: CommittedBodyIds, messages: PersistedMessage[]): void {
  for (const msg of messages) {
    for (const t of msg.toolUse ?? []) ids.toolInputs.add(t.id);
    for (const r of msg.toolResults ?? []) ids.toolResults.add(r.toolUseId);
    for (const ev of msg.subagentEvents ?? []) {
      if (ev.kind === "assistant") {
        for (const t of ev.toolUse ?? []) ids.toolInputs.add(t.id);
      } else {
        for (const r of ev.toolResults) ids.toolResults.add(r.toolUseId);
      }
    }
  }
}

function toolNamesFor(msg: PersistedMessage): Map<string, string> {
  const names = new Map<string, string>();
  for (const t of msg.toolUse ?? []) names.set(t.id, t.name);
  for (const ev of msg.subagentEvents ?? []) {
    if (ev.kind === "assistant") for (const t of ev.toolUse ?? []) names.set(t.id, t.name);
  }
  return names;
}

// Remove bodies only after persistence makes them available to fetch.
export interface WireProjectionOptions {
  allRowsPersisted?: boolean;
  committedBodyIds?: CommittedBodyIds;
}

export function projectMessagesForWire(
  sessionId: string,
  messages: PersistedMessage[],
  { allRowsPersisted = true, committedBodyIds }: WireProjectionOptions = {},
): PersistedMessage[] {
  const inputCommitted = (id: string): boolean =>
    allRowsPersisted || (committedBodyIds?.toolInputs.has(id) ?? false);
  const resultCommitted = (id: string): boolean =>
    allRowsPersisted || (committedBodyIds?.toolResults.has(id) ?? false);

  return messages.map((msg) => {
    const names = toolNamesFor(msg);
    let changed = false;

    const toolResults = msg.toolResults?.map((r) => {
      const projected = projectToolResult(sessionId, r, names.get(r.toolUseId));
      if (projected !== r) changed = true;
      return projected;
    });

    const toolUse = msg.toolUse?.map((t) => {
      if (!inputCommitted(t.id)) return t;
      const projected = projectToolUse(t);
      if (projected !== t) changed = true;
      return projected;
    });

    const subAgentConsult = msg.subAgentConsult
      ? projectConsultCardForWire(msg.subAgentConsult)
      : undefined;
    if (subAgentConsult && subAgentConsult !== msg.subAgentConsult) changed = true;

    const images = msg.images?.map((img) => {
      if (!img.data) return img;
      changed = true;
      return { mediaType: img.mediaType, src: imageUrl(sessionId, imageHash(img.data)) };
    });

    const subagentEvents = msg.subagentEvents?.map((ev) => {
      if (ev.kind === "tool_result") {
        // Nested results persist at a later top-level tool-result boundary.
        const results = ev.toolResults.map((r) =>
          resultCommitted(r.toolUseId) ? projectToolResult(sessionId, r, names.get(r.toolUseId)) : r);
        if (results.some((r, i) => r !== ev.toolResults[i])) {
          changed = true;
          return { ...ev, toolResults: results };
        }
        return ev;
      }
      const original = ev.toolUse;
      if (!original) return ev;
      const tools = original.map((t) => (inputCommitted(t.id) ? projectToolUse(t) : t));
      if (tools.some((t, i) => t !== original[i])) {
        changed = true;
        return { ...ev, toolUse: tools };
      }
      return ev;
    });

    if (!changed) return msg;
    return {
      ...msg,
      ...(toolResults ? { toolResults } : {}),
      ...(toolUse ? { toolUse } : {}),
      ...(images ? { images } : {}),
      ...(subagentEvents ? { subagentEvents } : {}),
      ...(subAgentConsult ? { subAgentConsult } : {}),
    };
  });
}

// Only top-level results persist before this live emit. Store the original event.
export function projectAgentEventForWire(
  sessionId: string,
  event: AgentEvent,
  toolNameOf: (id: string) => string | undefined,
): AgentEvent {
  if (event.type === "agent_tool_result") {
    if (event.parentToolUseId) return event;
    const content: unknown = (event as { content?: unknown }).content;
    if (!Array.isArray(content)) return event;
    let changed = false;
    const blocks = (content as unknown[]).map((b): unknown => {
      if (typeof b !== "object" || b === null) return b;
      const block = b as Record<string, unknown>;
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") return b;
      const raw = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      const projected = projectToolResult(
        sessionId,
        { toolUseId: block.tool_use_id, content: raw },
        toolNameOf(block.tool_use_id),
      );
      if (projected.content === raw && !projected.truncated) return b;
      changed = true;
      return {
        ...block,
        content: projected.content,
        ...(projected.truncated ? {
          shipit_truncated: true,
          shipit_total_lines: projected.totalLines,
          shipit_total_bytes: projected.totalBytes,
        } : {}),
      };
    });
    return changed ? { ...event, content: blocks } : event;
  }

  return event;
}

export function projectTurnSnapshotForWire(
  sessionId: string,
  messages: PersistedMessage[],
  committed?: CommittedBodyIds,
): PersistedMessage[] {
  return projectMessagesForWire(sessionId, messages, {
    allRowsPersisted: false,
    ...(committed ? { committedBodyIds: committed } : {}),
  });
}
