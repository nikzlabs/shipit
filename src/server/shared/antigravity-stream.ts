/**
 * The Antigravity CLI's NDJSON stream, as captured on 1.2.2
 * (docs/301-antigravity-harness/probes/). Three events: `init`, `step_update`
 * and a terminal `result`.
 */

export interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export type AntigravityStepType =
  | "user_input"
  | "agent_response"
  | "system_message"
  | "error_message"
  | "tool";

export interface AntigravityStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: "ACTIVE" | "DONE";
  step_type?: AntigravityStepType;
  text_delta?: string;
  tool_name?: string;
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
    output?: string;
  };
  usage?: AntigravityUsage;
  duration_seconds?: number;
}

export interface AntigravityInit {
  model?: string;
  cwd?: string;
  tools?: string[];
  permission_mode?: string;
}

export interface AntigravityResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  num_turns?: number;
  duration_seconds?: number;
  usage?: AntigravityUsage;
}

export type AntigravityEvent =
  | { event: "init"; conversation_id?: string; init?: AntigravityInit }
  | { event: "step_update"; step_update?: AntigravityStepUpdate }
  | { event: "result"; result?: AntigravityResult };

export function parseAntigravityLine(line: string): AntigravityEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const event = (parsed as { event?: unknown }).event;
  if (event !== "init" && event !== "step_update" && event !== "result") return null;
  return parsed as AntigravityEvent;
}

/**
 * The CLI mirrors a terminal failure to stderr as an error line, and an
 * `error_message` step carries no text at all.
 *
 * The prefix's CASE is a version difference, not a detail: 1.1.27 writes
 * `Error:` and 1.2.2 writes `error:`, so a case-sensitive match finds Google's
 * refusal on one version and nothing on the other (req 4). And under
 * `--output-format stream-json` 1.1.27 writes NOTHING here at all — the text is
 * only in the result envelope — which is why the adapter falls back to it for a
 * turn it has already decided failed.
 */
export function antigravityStderrErrorText(stderr: string): string | undefined {
  const lines = stderr.split("\n");
  const collected: string[] = [];
  let capturing = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^error:/i.test(line)) {
      capturing = true;
      collected.push(line.slice("error:".length).trim());
      continue;
    }
    // Google's refusals continue across lines; keep them until a blank line.
    if (capturing) {
      if (line.trim().length === 0) break;
      collected.push(line.trim());
    }
  }
  const text = collected.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

export interface AntigravityTurnTokens {
  input: number;
  output: number;
  cacheRead: number;
  thinking: number;
}

/**
 * A resumed run's `result.usage` is cumulative over the whole conversation, so
 * the turn's own cost is the sum of THIS stream's step usages. Cache reads sit
 * OUTSIDE `input_tokens`, verified on every captured step
 * (docs/301 plan.md, "Token accounting").
 */
export class AntigravityUsageAccumulator {
  private readonly totals: AntigravityTurnTokens = { input: 0, output: 0, cacheRead: 0, thinking: 0 };
  private lastContext: number | undefined;
  private seen = false;
  /** A step is reported on both ACTIVE and DONE; count each index once. */
  private readonly countedSteps = new Set<number>();

  observe(step: AntigravityStepUpdate): void {
    const usage = step.usage;
    if (!usage) return;
    const index = step.step_index ?? -1;
    if (this.countedSteps.has(index)) return;
    this.countedSteps.add(index);
    this.seen = true;
    this.totals.input += usage.input_tokens ?? 0;
    this.totals.output += usage.output_tokens ?? 0;
    this.totals.cacheRead += usage.cache_read_tokens ?? 0;
    this.totals.thinking += usage.thinking_tokens ?? 0;
    const context = (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0);
    if (context > 0) this.lastContext = context;
  }

  get tokens(): AntigravityTurnTokens | undefined {
    return this.seen ? { ...this.totals } : undefined;
  }

  /** The last step's prompt occupancy: uncached input plus what was read from cache. */
  get contextTokens(): number | undefined {
    return this.lastContext;
  }
}
