// Background tasks send one launch result; completion replaces it in live and persisted history.
import { isBackgroundLaunchAck, parseSubagentReport } from "../shared/subagent-report.js";
import { SUBAGENT_REPORT_TOOL_NAMES } from "../shared/transcript-slice-tools.js";

export interface SubagentResultSlot {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface SubagentResultCarrier {
  toolUse?: { id: string; name: string }[];
  toolResults?: SubagentResultSlot[];
}

export type SubagentTerminalStatus = "completed" | "failed" | "stopped";

export interface BackgroundSubagentCompletion {
  toolUseId: string;
  status: SubagentTerminalStatus;
  // The notification summary is the final report; output_file contains the full transcript.
  summary?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
}

export interface RetiredSubagentResult {
  content: string;
  isError?: boolean;
}

export function toTerminalStatus(status: string | undefined): SubagentTerminalStatus | null {
  if (status === "completed" || status === "failed" || status === "stopped") return status;
  return null;
}

export const NO_REPORT_TEXT = "_The subagent finished without returning a report._";
export const STOPPED_TEXT = "_The subagent was stopped before it finished, so there is no report._";
export const FAILED_FALLBACK_TEXT = "The subagent failed without reporting a reason.";

export function buildRetiredSubagentResult(
  completion: BackgroundSubagentCompletion,
): RetiredSubagentResult {
  const summary = completion.summary?.trim() ?? "";

  if (completion.status === "failed") {
    return { content: withFooter(summary || FAILED_FALLBACK_TEXT, completion.usage), isError: true };
  }
  if (completion.status === "stopped") {
    return { content: withFooter(STOPPED_TEXT, completion.usage) };
  }
  return { content: withFooter(summary || NO_REPORT_TEXT, completion.usage) };
}

function withFooter(
  text: string,
  usage: BackgroundSubagentCompletion["usage"],
): string {
  // parseReportMeta expects the CLI's key:value text format.
  const lines: string[] = [];
  if (typeof usage?.totalTokens === "number") lines.push(`subagent_tokens: ${usage.totalTokens}`);
  if (typeof usage?.toolUses === "number") lines.push(`tool_uses: ${usage.toolUses}`);
  if (typeof usage?.durationMs === "number") lines.push(`duration_ms: ${usage.durationMs}`);
  if (lines.length === 0) return text;
  return JSON.stringify([
    { type: "text", text },
    { type: "text", text: lines.join("\n") },
  ]);
}

export function retireBackgroundSubagentResult(
  carrier: SubagentResultCarrier,
  completion: BackgroundSubagentCompletion,
  built: RetiredSubagentResult,
): RetiredSubagentHit | null {
  // Shell tasks also send notifications; never overwrite their output.
  const tool = carrier.toolUse?.find(
    (t) => t.id === completion.toolUseId && SUBAGENT_REPORT_TOOL_NAMES.has(t.name),
  );
  if (!tool) return null;

  const slot = carrier.toolResults?.find((r) => r.toolUseId === completion.toolUseId);
  if (!slot) return null;
  if (slot.isError) return null;
  // Replayed notifications must not replace a report already received.
  if (!isBackgroundLaunchAck(parseSubagentReport(slot.content).text)) return null;

  slot.content = built.content;
  if (built.isError) slot.isError = true;
  return { toolName: tool.name, slot };
}

export interface RetiredSubagentHit {
  toolName: string;
  slot: SubagentResultSlot;
}

export function retireInCarriers(
  carriers: SubagentResultCarrier[],
  completion: BackgroundSubagentCompletion,
  built: RetiredSubagentResult,
): RetiredSubagentHit | null {
  for (const carrier of carriers) {
    const hit = retireBackgroundSubagentResult(carrier, completion, built);
    if (hit) return hit;
  }
  return null;
}
