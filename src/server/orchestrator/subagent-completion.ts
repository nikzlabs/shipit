/**
 * Retire the card of a subagent that was launched with `run_in_background`
 * (docs/109 requirements 10–11).
 *
 * ## The gap this closes
 *
 * A backgrounded `Task`/`Agent` call gets exactly ONE `tool_result`, written at
 * launch: the CLI's acknowledgement ("Async agent launched successfully…"),
 * which is machinery addressed to the agent. `SubagentReport` recognises it
 * ({@link isBackgroundLaunchAck}) and draws a running row instead of a report —
 * correct at launch, and correct forever after, because **no second
 * `tool_result` is ever emitted for that tool_use id**. So the card said
 * "Running in the background — its report will appear here when it finishes"
 * permanently, including across reloads, long after the subagent had finished
 * and the parent agent had acted on its output.
 *
 * The completion IS on the wire — `system/task_notification` — and it carries
 * the correlation key. Verified against CLI 2.1.219 by running the exact
 * `StreamingClaudeProcess` invocation and backgrounding a subagent:
 *
 * ```
 * 11047ms  tool_result  toolu_013f…  "Async agent launched successfully…"   <- the ack
 * 13783ms  system/task_notification {
 *            task_id, tool_use_id: "toolu_013f…", status: "completed",
 *            output_file: "…/tasks/<id>.output",
 *            summary: "## Probe report\n\nThe number seven…",     <- the whole report
 *            usage: { total_tokens: 10408, tool_uses: 0, duration_ms: 2757 } }
 * 13951ms  result/success                                          <- turn 1 ends
 * ```
 *
 * Two things in that trace shape this module:
 *
 *  1. **`summary` is the report**, not a one-liner. The CLI sets a finished
 *     subagent's terminal summary to its joined final text. So the fix does not
 *     need to invent a payload, and — importantly — it must NOT read
 *     `output_file`, which is the subagent's full JSONL transcript (the ack
 *     says so outright).
 *  2. **The notification can land mid-turn.** Here it arrived 168ms *before*
 *     the launching turn's `result`. A short subagent finishing inside its own
 *     launching turn is the common case, not an edge one — which is why the
 *     applier below is run against the runner's live accumulator as well as
 *     against committed history.
 *
 * ## Why rewriting the result, rather than adding a card state
 *
 * Once the stored `tool_result` holds the report, `isBackgroundLaunchAck` stops
 * matching and every existing piece of docs/109 does its normal job with no
 * client change: the badge flips to `done` / `failed`, `ReportPanel` renders the
 * markdown, `parseReportMeta` draws the accounting chips, `sliceSubagentReport`
 * clamps it on the serve path, and the modal fetches the rest from
 * `/api/sessions/:id/tool-results/:toolUseId`. The alternative — a new field
 * describing "background, but finished" — would have re-implemented all five.
 */

import { isBackgroundLaunchAck, parseSubagentReport } from "../shared/subagent-report.js";
import { SUBAGENT_REPORT_TOOL_NAMES } from "../shared/transcript-slice-tools.js";

/** The subset of a stored tool result this module reads and rewrites. */
export interface SubagentResultSlot {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/**
 * Anything holding a tool_use list beside its tool results — a persisted
 * message row or a live `ChatMessageGroup`. Structural on purpose: the same
 * patch has to run against committed history and the runner's accumulator, and
 * those are two different types describing the same pair of arrays.
 */
export interface SubagentResultCarrier {
  toolUse?: { id: string; name: string }[];
  toolResults?: SubagentResultSlot[];
}

/** What the notification says happened. Every value is terminal. */
export type SubagentTerminalStatus = "completed" | "failed" | "stopped";

export interface BackgroundSubagentCompletion {
  toolUseId: string;
  status: SubagentTerminalStatus;
  /** The report (completed) or the failure text (failed). May be absent. */
  summary?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
}

/** The rewritten tool result: what the card will render from now on. */
export interface RetiredSubagentResult {
  content: string;
  isError?: boolean;
}

/**
 * Narrow the backend's free-form status string to the three terminal values.
 *
 * Anything unrecognised returns null and the completion is ignored rather than
 * guessed at: a status we do not model is not evidence that the subagent
 * finished, and retiring the card on it would trade a card stuck on "running"
 * for one that lies about being done.
 */
export function toTerminalStatus(status: string | undefined): SubagentTerminalStatus | null {
  if (status === "completed" || status === "failed" || status === "stopped") return status;
  return null;
}

/**
 * ShipIt's own words, used only where the backend gave us nothing usable. Kept
 * as constants so the tests assert the same strings the UI shows.
 */
export const NO_REPORT_TEXT = "_The subagent finished without returning a report._";
export const STOPPED_TEXT = "_The subagent was stopped before it finished, so there is no report._";
export const FAILED_FALLBACK_TEXT = "The subagent failed without reporting a reason.";

/**
 * Build the tool-result content that replaces the launch acknowledgement.
 *
 * The accounting footer is rebuilt in the CLI's own `key: value` shape rather
 * than passed as structured data, because that is the only shape
 * {@link parseReportMeta} reads — the chips come from parsing a text block, so
 * emitting one is what makes them appear. `agentId` is deliberately never
 * written: requirement 5 says it must not reach the reader, and the surest way
 * to keep that true is for it never to enter the payload.
 */
export function buildRetiredSubagentResult(
  completion: BackgroundSubagentCompletion,
): RetiredSubagentResult {
  const summary = completion.summary?.trim() ?? "";

  if (completion.status === "failed") {
    return { content: withFooter(summary || FAILED_FALLBACK_TEXT, completion.usage), isError: true };
  }
  if (completion.status === "stopped") {
    // Not `isError`: nobody's code failed, so the red "Subagent failed" panel
    // would send the reader looking for a fault that isn't there. The body says
    // what happened instead.
    return { content: withFooter(STOPPED_TEXT, completion.usage) };
  }
  return { content: withFooter(summary || NO_REPORT_TEXT, completion.usage) };
}

function withFooter(
  text: string,
  usage: BackgroundSubagentCompletion["usage"],
): string {
  const lines: string[] = [];
  if (typeof usage?.totalTokens === "number") lines.push(`subagent_tokens: ${usage.totalTokens}`);
  if (typeof usage?.toolUses === "number") lines.push(`tool_uses: ${usage.toolUses}`);
  if (typeof usage?.durationMs === "number") lines.push(`duration_ms: ${usage.durationMs}`);
  // No footer → keep the plain-string shape a report normally arrives in, so
  // nothing downstream has to unwrap a single-element array for nothing.
  if (lines.length === 0) return text;
  return JSON.stringify([
    { type: "text", text },
    { type: "text", text: lines.join("\n") },
  ]);
}

/**
 * Rewrite the launch acknowledgement in one carrier, if it holds the card.
 *
 * Three conditions, all required, and each one guarding a different way this
 * could damage an unrelated result:
 *
 *  1. the carrier has a `tool_use` with this id whose **name is a report-tool
 *     name**. `task_notification` fires for background *shell* commands too,
 *     and those carry the Bash call's `tool_use_id` with a one-line summary —
 *     overwriting that result would replace real command output with
 *     `Background command "npm test" completed`;
 *  2. the matching result still **is** the launch acknowledgement. This is what
 *     makes the whole path idempotent: a replayed or duplicated notification
 *     (the CLI warns that "the same task-id may notify more than once", e.g.
 *     after the agent is resumed with `SendMessage`) finds a real report there
 *     and leaves it alone, so a later, fuller report is never clobbered by an
 *     earlier one;
 *  3. it is not already an error result, matching `SubagentReport`'s own order
 *     of checks.
 *
 * Mutates in place. Returns the rewritten result and the name of the tool that
 * owns it (which the caller needs to project it for the wire), or null when
 * this carrier does not hold a retirable acknowledgement for that id.
 */
export function retireBackgroundSubagentResult(
  carrier: SubagentResultCarrier,
  completion: BackgroundSubagentCompletion,
  built: RetiredSubagentResult,
): RetiredSubagentHit | null {
  const tool = carrier.toolUse?.find(
    (t) => t.id === completion.toolUseId && SUBAGENT_REPORT_TOOL_NAMES.has(t.name),
  );
  if (!tool) return null;

  const slot = carrier.toolResults?.find((r) => r.toolUseId === completion.toolUseId);
  if (!slot) return null;
  if (slot.isError) return null;
  if (!isBackgroundLaunchAck(parseSubagentReport(slot.content).text)) return null;

  slot.content = built.content;
  if (built.isError) slot.isError = true;
  return { toolName: tool.name, slot };
}

/** The rewritten slot, plus the tool name the wire projection is keyed on. */
export interface RetiredSubagentHit {
  toolName: string;
  slot: SubagentResultSlot;
}

/**
 * Run {@link retireBackgroundSubagentResult} over a list of carriers, stopping
 * at the first hit. A tool_use id is unique within a session, so there is at
 * most one.
 */
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
