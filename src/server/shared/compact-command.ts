/**
 * The `/compact` composer command, recognized identically on both sides.
 *
 * docs/178 §4 — matches a leading `/compact` token only (so `/compactfoo` is
 * not a match), with optional custom-compaction args (`/compact <instructions>`,
 * which Claude's CLI honors). Recognizing the arg form matters for correctness,
 * not just Claude parity: without it a `/compact <args>` on Codex would fall
 * through and be sent as a literal `turn/start` prompt — a no-op — instead of
 * routing to its compaction RPC.
 *
 * docs/294 reqs 5-6 — it lives in `shared/` because the client now needs the
 * same answer: `/compact` is a control command, so it carries no attachment and
 * does not clear the composer's chips. A second regex on the client would be one
 * that could drift, and the failure mode of drift here is exactly the silent
 * attachment loss this is fixing.
 */
export function parseCompactCommand(text: string): { match: boolean; instructions?: string } {
  const m = /^\/compact(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!m) return { match: false };
  const instructions = m[1]?.trim();
  return instructions ? { match: true, instructions } : { match: true };
}

/** True when this composer text is the `/compact` command rather than a message. */
export function isCompactCommand(text: string): boolean {
  return parseCompactCommand(text).match;
}
