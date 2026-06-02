/**
 * Shared AskUserQuestion normalization (docs/147).
 *
 * The ShipIt-managed `shipit-ask` MCP bridge lets Codex ask structured
 * multiple-choice questions. The bridge POSTs the raw `questions` argument to
 * the worker (`POST /agent-ops/ask/submit`), which normalizes it here into the
 * exact shape the question card requires and injects it into the agent event
 * stream as an `AskUserQuestion` tool_use. Keeping the normalizer in its own
 * module lets the worker reuse it without dragging in the Codex adapter, and
 * keeps it independently unit-testable.
 */

export interface NormalizedAskOption {
  label: string;
  description: string;
}

export interface NormalizedAskQuestion {
  question: string;
  header: string;
  options: NormalizedAskOption[];
  multiSelect: boolean;
}

/**
 * Normalize a raw `questions` argument into `{ question, header, options:
 * [{ label, description }], multiSelect }`. Defensive against fields the model
 * might omit (missing `description`, missing `multiSelect`) so the card always
 * renders. Options without a non-empty `label` are dropped (they can't render).
 * Returns `[]` for a non-array input or one with no usable questions — the
 * worker route then rejects the call so the bridge surfaces an error to the
 * model rather than blocking forever.
 */
export function normalizeAskQuestions(raw: unknown): NormalizedAskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedAskQuestion[] = [];
  for (const q of raw) {
    if (typeof q !== "object" || q === null) continue;
    const obj = q as Record<string, unknown>;
    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    const options = rawOptions
      .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
      .map((o) => ({
        label: typeof o.label === "string" ? o.label : "",
        description: typeof o.description === "string" ? o.description : "",
      }))
      .filter((o) => o.label.length > 0);
    if (options.length === 0) continue;
    out.push({
      question: typeof obj.question === "string" ? obj.question : "",
      header: typeof obj.header === "string" ? obj.header : "",
      options,
      multiSelect: obj.multiSelect === true,
    });
  }
  return out;
}
