/**
 * Grok Build's headless stream — the wire types and the line parser
 * (docs/274-grok-build-harness).
 *
 * `--output-format streaming-messages-json` emits NDJSON in Claude Code's
 * `stream-json` shape: a `system`/`init` handshake, `assistant` / `user`
 * envelopes each wrapping an Anthropic Messages object, and one terminal
 * `result`. **The schema is undocumented** — docs.x.ai's headless page covers
 * neither format — so every field below was read off real captured turns (CLI
 * 1.0.1, 2026-08-18, `grok-4.20-0309-non-reasoning` and `grok-4.6`), and
 * `adapter.test.ts` replays those captures byte-for-byte to keep this honest.
 *
 * Typed loosely on purpose. This is a third party's undocumented wire under
 * weekly releases, so every field is optional and the adapter tolerates
 * absence: a stricter type would turn a new xAI field into a parse failure and
 * lose a whole turn's transcript rather than the one field it did not expect.
 */

import type { AgentContentBlock } from "../../../shared/types/agent-types.js";

/** Per-model usage, keyed by model id — the only place the context window is stated. */
export interface GrokModelUsage {
  contextWindow?: number;
  costUSD?: number;
}

/** The Anthropic-shaped `usage` object carried on assistant messages and the result. */
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

/**
 * One line of the stream.
 *
 * A single interface rather than a discriminated union, because the adapter
 * switches on `type` and reads only the fields that type carries. A union would
 * be more precise about a shape ShipIt does not control and cannot verify
 * beyond the runs it has captured.
 */
export interface GrokEvent {
  type: string;
  /**
   * `init` on the handshake; `success` / an error kind on the result;
   * `compact_boundary` on a context compaction (docs/276).
   */
  subtype?: string;
  /**
   * docs/276 — payload of a `system`/`compact_boundary` event. Same field names
   * as Claude's, but Grok fills fewer of them: `pre_tokens` only, with no
   * `post_tokens` and no `duration_ms`. `trigger` is present and is ALWAYS
   * `"auto"`, even for a compaction ShipIt requested — the adapter labels by
   * correlation instead and deliberately never reads this field.
   */
  compact_metadata?: {
    trigger?: string;
    pre_tokens?: number;
    post_tokens?: number;
  };
  session_id?: string;
  model?: string;
  tools?: string[];
  /** Per-server MCP state on the init event — `{name, status}` rows. */
  mcp_servers?: { name: string; status: string }[];
  message?: GrokMessage;
  /**
   * Claude's subagent-nesting field. Present in Grok's schema and NULL on every
   * event of every capture, including turns that ran `spawn_subagent` — the CLI
   * does not stream a subagent's internals headlessly. Carried anyway so the
   * mapping does not have to change if that ever starts arriving.
   */
  parent_tool_use_id?: string | null;
  is_error?: boolean;
  duration_ms?: number;
  /**
   * The turn's final assistant text — **on a SUCCESS only**.
   *
   * Do not read this as "the failure reason on an error", which is Claude's
   * contract and was assumed to be Grok's. Measured against CLI 1.0.1 at a
   * local recorder: a `result` event with `is_error: true` carries no `result`
   * key at all, and puts the reason in {@link GrokEvent.errors} instead. The
   * two fields are disjoint per event, not alternatives for the same slot.
   */
  result?: string;
  /**
   * The failure reasons on an errored `result` event — the field Grok actually
   * uses where Claude reuses `result`.
   *
   * Load-bearing for quota detection, which is how the divergence was found.
   * Every vendored fixture is a successful tool-tour, so nothing had ever
   * exercised an errored terminal event, and the adapter's `raw.result`
   * fallback replaced the provider's own words with `Grok ended the turn with
   * subtype "error_during_execution"` — a string no exhaustion pattern can
   * match. A metered 429 at a local recorder arrives here as
   * `["Out of credits: <the service's own message>"]`, which
   * `EXHAUSTION_PATTERNS` already matches; it simply never reached the
   * classifier. See `docs/274-grok-build-harness/plan.md`, "Exhaustion".
   *
   * An ARRAY because the CLI can report more than one; the adapter joins them.
   * The entry is the service's own `code` and `error` joined by `": "`, so the
   * vendor's wording reaches ShipIt verbatim rather than through CLI copy.
   */
  errors?: string[];
  total_cost_usd?: number;
  usage?: GrokUsage;
  modelUsage?: Record<string, GrokModelUsage | undefined>;
  /** The fatal `{"type":"error","message":…}` shape (e.g. an unauthenticated run). */
  message_text?: string;
}

/**
 * Parse one NDJSON line, or `null` for anything unusable.
 *
 * Silent on a bad line by design: this stream is interleaved with whatever the
 * CLI decides to print, and one unparseable line must cost that line rather
 * than the turn.
 */
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
  // The fatal error shape puts its text on `message` as a STRING, where every
  // other event has an object there. Normalizing it onto its own field is what
  // keeps `message` typed as the Messages object the rest of the stream sends.
  if (event.type === "error" && typeof event.message === "string") {
    return { type: "error", message_text: event.message };
  }
  return event as unknown as GrokEvent;
}

/**
 * The reason text for an errored `result` event, in the order the CLI actually
 * fills the fields.
 *
 * `errors` first, because that is the one Grok populates (see
 * {@link GrokEvent.errors}); `result` second, because a future release adopting
 * Claude's single-field shape should not silently regress to the placeholder;
 * the placeholder last, so a shape nobody has seen still names its subtype.
 *
 * Blank and whitespace-only entries are dropped rather than joined, so an empty
 * `errors: [""]` falls through to the next source instead of handing the
 * orchestrator's exhaustion classifier an empty string to test.
 */
export function grokResultErrorText(event: GrokEvent): string {
  const listed = (event.errors ?? [])
    .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
    .join("; ");
  if (listed.length > 0) return listed;
  if (typeof event.result === "string" && event.result.trim().length > 0) return event.result;
  return `Grok ended the turn with subtype "${event.subtype ?? "unknown"}"`;
}
