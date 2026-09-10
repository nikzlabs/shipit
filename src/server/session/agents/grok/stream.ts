// Undocumented NDJSON schema captured from Grok CLI 1.0.1 (2026-08-18).
import type { AgentContentBlock } from "../../../shared/types/agent-types.js";

export interface GrokModelUsage {
  contextWindow?: number;
  costUSD?: number;
}

export interface GrokUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface GrokMessage {
  role?: string;
  model?: string;
  content?: AgentContentBlock[];
  stop_reason?: string | null;
  usage?: GrokUsage;
}

export interface GrokEvent {
  type: string;
  subtype?: string;
  // Grok reports trigger="auto" even for manual compaction; correlate it instead.
  compact_metadata?: {
    trigger?: string;
    pre_tokens?: number;
    post_tokens?: number;
  };
  session_id?: string;
  model?: string;
  tools?: string[];
  mcp_servers?: { name: string; status: string }[];
  message?: GrokMessage;
  parent_tool_use_id?: string | null;
  is_error?: boolean;
  duration_ms?: number;
  // Success text. Grok puts failure reasons in errors[], unlike Claude.
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  usage?: GrokUsage;
  modelUsage?: Record<string, GrokModelUsage | undefined>;
  message_text?: string;
}

export function parseGrokLine(line: string): GrokEvent | null {
  const trimmed = line.trim();
  if (!trimmed?.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const event = parsed as Record<string, unknown>;
  if (typeof event.type !== "string") return null;
  // Fatal errors use a string message; other events use a Messages object.
  if (event.type === "error" && typeof event.message === "string") {
    return { type: "error", message_text: event.message };
  }
  return event as unknown as GrokEvent;
}

// Prefer CLI errors for quota detection. The legacy result fallback can contain model prose.
export function grokResultErrorText(event: GrokEvent): string {
  const listed = (event.errors ?? [])
    .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
    .join("; ");
  if (listed.length > 0) return listed;
  if (typeof event.result === "string" && event.result.trim().length > 0) return event.result;
  return `Grok ended the turn with subtype "${event.subtype ?? "unknown"}"`;
}
