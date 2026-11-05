import type { ChatMessage, SubagentEvent, ToolResultBlock, ToolUseBlock } from "../components/MessageList.js";
import type { SubAgentConsultCard } from "../../server/shared/types.js";
import type { SubAgentSpawnChip } from "../stores/session-store.js";
import { SUBAGENT_REPORT_TOOL_NAMES } from "../../server/shared/transcript-slice-tools.js";
import { getHarness, getModel } from "../../server/shared/catalogue/index.js";
import { billingModeLabel, serviceLabel } from "./service-label.js";
import { isBackgroundLaunchAck, parseReportMeta, parseSubagentReport } from "./group-events-by-parent.js";
import { STOPPED_TEXT } from "../../server/shared/subagent-report.js";

export type SubagentRunStatus = "running" | "done" | "failed";

interface SubagentRunBase {
  key: string;
  status: SubagentRunStatus;
  name: string;
  /** The short grey line beside the name. */
  detail: string;
  startedAt?: string;
  durationMs?: number;
}

/** A sub-agent the agent itself launched (Claude's Agent tool, Codex's normalized spawn_agent). */
export interface NativeSubagentRun extends SubagentRunBase {
  kind: "native";
  tool: ToolUseBlock;
  events: SubagentEvent[];
  result?: ToolResultBlock;
  backgrounded: boolean;
  /** The launching turn ended without a result, or a background run was stopped. */
  stopped: boolean;
  subagentType?: string;
  toolCalls: number;
}

/** A `shipit agent run` sub-agent. `card` is absent only while the spawn has no card yet. */
export interface ConsultSubagentRun extends SubagentRunBase {
  kind: "consult";
  card?: SubAgentConsultCard;
  subAgentId: string;
  /** The full run-on line (docs/261 req 9), or null for a card that predates it. */
  attribution: string | null;
}

export type SubagentRun = NativeSubagentRun | ConsultSubagentRun;

export const SUB_AGENT_DISPLAY_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", opencode2: "OpenCode 2", grok: "Grok Build", antigravity: "Antigravity" };

/**
 * docs/261 phase 4 (req 9) — what a consult ran on. `subject` is the MODEL,
 * because the model is what did the work and Claude Code can drive a
 * non-Anthropic one; `attribution` is the role it was started as (docs/264
 * req 14), then service, billing mode, harness and reasoning level. Ids the
 * catalogue has since dropped fall back to themselves, so an old card keeps its
 * provenance. A card with no `runOn` predates this and names the harness.
 */
export function describeRun(card: SubAgentConsultCard): { subject: string; attribution: string | null; effort: string | null } {
  const harness = SUB_AGENT_DISPLAY_NAMES[card.subAgentId] ?? card.subAgentId;
  const runOn = card.runOn;
  if (!runOn) return { subject: harness, attribution: null, effort: null };

  const reasoning = getHarness(card.subAgentId)?.capabilities.reasoning;
  const effort =
    runOn.reasoningEffort === undefined
      ? "Default"
      : (reasoning?.options.find((o) => o.value === runOn.reasoningEffort)?.label
        ?? runOn.reasoningEffort);
  return {
    subject: getModel(runOn)?.label ?? runOn.modelId,
    attribution: [
      ...(card.roleName ? [`as ${card.roleName}`] : []),
      serviceLabel(runOn.serviceId),
      billingModeLabel(runOn.billingMode),
      harness,
      `${effort} reasoning`,
    ].join(" · "),
    effort,
  };
}

function countToolCalls(events: SubagentEvent[]): number {
  let n = 0;
  for (const ev of events) if (ev.kind === "assistant") n += ev.toolUse.length;
  return n;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// A report is re-read on every transcript update while the agent streams; the
// result object is replaced only when it changes, so its parse is cached on it.
const parsedReports = new WeakMap<ToolResultBlock, ReturnType<typeof parseSubagentReport>>();
function parsedReport(result: ToolResultBlock): ReturnType<typeof parseSubagentReport> {
  let parsed = parsedReports.get(result);
  if (!parsed) {
    parsed = parseSubagentReport(result.content);
    parsedReports.set(result, parsed);
  }
  return parsed;
}

function nativeRun(
  tool: ToolUseBlock,
  msg: ChatMessage,
  turnLive: boolean,
): NativeSubagentRun {
  const events = (msg.subagentEvents ?? []).filter((e) => e.parentToolUseId === tool.id);
  const result = msg.toolResults?.find((r) => r.toolUseId === tool.id);
  const report = result ? parsedReport(result) : null;
  const backgrounded = !!report && !result?.isError && isBackgroundLaunchAck(report.text);
  const meta = report && !backgrounded ? parseReportMeta(report.meta) : null;
  const stopped = (!result && !turnLive)
    || (!!report && !result?.isError && report.text.trim() === STOPPED_TEXT);

  const status: SubagentRunStatus =
    backgrounded || (!result && turnLive) ? "running"
    : stopped || result?.isError ? "failed"
    : "done";

  const subagentType = typeof tool.input.subagent_type === "string" && tool.input.subagent_type
    ? tool.input.subagent_type
    : undefined;
  const toolCalls = meta?.toolUses ?? countToolCalls(events);
  const description = typeof tool.input.description === "string" ? tool.input.description.trim() : "";

  return {
    kind: "native",
    key: `native:${tool.id}`,
    status,
    name: description || "Sub-agent",
    detail: [
      ...(subagentType ? [subagentType] : []),
      ...(backgrounded ? ["background"] : []),
      ...(stopped ? ["stopped"] : []),
      plural(toolCalls, "tool call"),
    ].join(" · "),
    ...(tool.startedAt ? { startedAt: tool.startedAt } : {}),
    ...(meta?.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
    tool,
    events,
    ...(result ? { result } : {}),
    backgrounded,
    stopped,
    ...(subagentType ? { subagentType } : {}),
    toolCalls,
  };
}

function consultRun(card: SubAgentConsultCard): ConsultSubagentRun {
  const { subject, attribution, effort } = describeRun(card);
  const harness = SUB_AGENT_DISPLAY_NAMES[card.subAgentId] ?? card.subAgentId;
  return {
    kind: "consult",
    key: `consult:${card.cardId}`,
    status: card.status === "pending" ? "running" : card.status === "success" ? "done" : "failed",
    name: subject,
    detail: [
      ...(card.roleName ? [card.roleName] : []),
      ...(subject !== harness ? [harness] : []),
      ...(effort ? [effort] : []),
    ].join(" · "),
    startedAt: card.createdAt,
    ...(card.durationMs !== undefined ? { durationMs: card.durationMs } : {}),
    card,
    subAgentId: card.subAgentId,
    attribution,
  };
}

/**
 * Every sub-agent of the session, in the order they appeared, read from the
 * same persisted history the transcript loads — so the list survives a reload
 * and a switch, and follows live updates (nested events, results, the
 * background-completion rewrite of docs/109 reqs 10–11, consult card updates).
 *
 * A launch with no result is running only while the turn that launched it is
 * still in flight: a turn is running and no turn-starting user row follows it.
 * A user row starts a turn unless it is queued, steered into the running turn
 * (`steered`, live) or one of the running turn's own rows (`inProgress`, after a
 * reload or snapshot — the server marks a steer that way, never the message
 * that started the turn). Otherwise the turn ended without a result: "stopped".
 */
export function deriveSubagentRuns(
  messages: ChatMessage[],
  { turnRunning, spawns = [] }: { turnRunning: boolean; spawns?: SubAgentSpawnChip[] },
): SubagentRun[] {
  let lastUserIndex = -1;
  messages.forEach((m, i) => {
    if (m.role === "user" && !m.queued && !m.steered && !m.inProgress) lastUserIndex = i;
  });

  const runs: SubagentRun[] = [];
  const cardSpawnIds = new Set<string>();
  messages.forEach((msg, i) => {
    for (const tool of msg.toolUse ?? []) {
      if (SUBAGENT_REPORT_TOOL_NAMES.has(tool.name)) {
        runs.push(nativeRun(tool, msg, turnRunning && i > lastUserIndex));
      }
    }
    if (msg.subAgentConsult) {
      cardSpawnIds.add(msg.subAgentConsult.spawnId);
      runs.push(consultRun(msg.subAgentConsult));
    }
  });
  for (const chip of spawns) {
    if (cardSpawnIds.has(chip.spawnId)) continue;
    runs.push({
      kind: "consult",
      key: `spawn:${chip.spawnId}`,
      status: "running",
      name: SUB_AGENT_DISPLAY_NAMES[chip.subAgentId] ?? chip.subAgentId,
      detail: "starting",
      subAgentId: chip.subAgentId,
      attribution: null,
    });
  }
  return runs;
}

/** `m:ss`, or `h:mm:ss` past an hour — the clock a line shows. */
export function formatRunClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Elapsed time while running, the recorded duration once finished; null when neither is known. */
export function runClock(run: SubagentRun, now: number): string | null {
  if (run.status === "running") {
    if (!run.startedAt) return null;
    const started = Date.parse(run.startedAt);
    return Number.isNaN(started) ? null : formatRunClock(now - started);
  }
  return run.durationMs !== undefined ? formatRunClock(run.durationMs) : null;
}
