/**
 * OpenCode `--format json` stream types and the per-turn accumulator.
 *
 * The wire schema was captured from live CLI 1.18.15 turns
 * (docs/268-opencode-harness/plan.md, "Phase 0 findings") — OpenCode documents
 * the format only loosely, and has known event-loss bugs, so this module is
 * written against observed events and the accumulator is what makes a lossy
 * stream survivable: **there is no terminal result event on the wire**. The
 * turn's result is synthesized from process exit, from whatever this
 * accumulator managed to see (req 4).
 *
 * Lives in `shared/` (like `codex-token-usage.ts`) because both the session
 * adapter and the orchestrator's session-namer parse this stream, and the
 * orchestrator must not import from `session/`.
 */

/** `part.tokens` on a `step_finish` event. Figures are DISJOINT (verified). */
export interface OpencodeTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface OpencodeStepFinishPart {
  type: "step-finish";
  reason?: string;
  tokens?: OpencodeTokens;
  cost?: number;
}

export interface OpencodeTextPart {
  type: "text";
  text?: string;
}

export interface OpencodeToolState {
  status?: string;
  input?: unknown;
  output?: string;
  metadata?: Record<string, unknown>;
  title?: string;
  time?: { start?: number; end?: number };
}

export interface OpencodeToolPart {
  type: "tool";
  tool?: string;
  callID?: string;
  state?: OpencodeToolState;
}

/**
 * One JSONL line of `opencode run --format json`. `type` stays an open string:
 * the observed vocabulary is step_start | text | tool_use | step_finish |
 * error, but the CLI ships every few days and an unknown event must parse (and
 * be ignored), not throw.
 */
export interface OpencodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: { id?: string; messageID?: string; sessionID?: string } & (
    | OpencodeStepFinishPart
    | OpencodeTextPart
    | OpencodeToolPart
    | { type?: string }
  );
  error?: { name?: string; data?: { message?: string; statusCode?: number; isRetryable?: boolean } };
}

/** Parse one stream line; returns null for blank/non-JSON lines. */
export function parseOpencodeLine(line: string): OpencodeEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { type?: unknown }).type === "string") {
      return parsed as OpencodeEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Everything the synthesized terminal result needs, accumulated as events
 * arrive. Token figures are summed across steps — each `step_finish` reports
 * that step's own API call — while `contextTokens` keeps only the LAST step's
 * prompt-side reading (input + reasoning + cache), which is the turn's final
 * context occupancy (same rule as the Claude adapter's iteration handling).
 */
export class OpencodeTurnAccumulator {
  sessionId: string | undefined;
  sawStepFinish = false;
  /**
   * A `step_finish` whose reason was anything but "tool-calls" — the turn's
   * final step completed. Load-bearing for two adapter decisions: when MCP
   * servers are configured the CLI never exits on its own after the turn
   * (verified live, 1.18.15 — the MCP children keep it alive), so the adapter
   * kills it after this; and a self-killed completed turn must read as
   * success even though the exit code is then the signal's, not 0.
   */
  sawFinalStop = false;
  errorMessage: string | undefined;
  finalText = "";
  costUsd = 0;
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  contextTokens: number | undefined;

  observe(event: OpencodeEvent): void {
    if (!this.sessionId && typeof event.sessionID === "string") {
      this.sessionId = event.sessionID;
    }
    switch (event.type) {
      case "text": {
        const part = event.part as OpencodeTextPart | undefined;
        // Whole-block text (no deltas on this wire). The turn's final answer is
        // the last text block; keep only that, matching what the CLI's default
        // format prints last.
        if (typeof part?.text === "string") this.finalText = part.text;
        break;
      }
      case "step_finish": {
        const part = event.part as OpencodeStepFinishPart | undefined;
        this.sawStepFinish = true;
        if (part?.reason !== "tool-calls") this.sawFinalStop = true;
        if (typeof part?.cost === "number") this.costUsd += part.cost;
        const t = part?.tokens;
        if (t) {
          this.input += t.input ?? 0;
          this.output += t.output ?? 0;
          this.cacheRead += t.cache?.read ?? 0;
          this.cacheWrite += t.cache?.write ?? 0;
          const context =
            (t.input ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
          if (context > 0) this.contextTokens = context;
        }
        break;
      }
      case "error": {
        const data = event.error?.data;
        this.errorMessage =
          data?.message ?? event.error?.name ?? "OpenCode reported an error";
        break;
      }
      default:
        break;
    }
  }
}
