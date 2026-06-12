/**
 * Parse a pull-request body for the issue pointers the issue-lifecycle workflow
 * acts on at merge time (docs/194).
 *
 * Two kinds of reference, distinguished by the leading keyword:
 *
 *  - **Closing** (`Closes`/`Fixes`/`Resolves <pointer>`) — the agent's
 *    per-PR declaration that this PR *finishes* the issue. On merge ShipIt
 *    flips the issue to `completed` and posts a resolved-by comment.
 *  - **Non-closing** (`Refs`/`References <pointer>`) — a progress link that
 *    leaves the status untouched. On merge ShipIt posts a progress comment
 *    only. This is how the agent logs an intermediate PR in a multi-PR thread
 *    without closing the issue.
 *
 * A PR whose body names *no* pointer produces neither — there is no stored
 * session↔issue linkage to recover the issue from, so an untagged PR gets no
 * automatic issue activity (the multi-PR case: intermediate PRs simply omit
 * `Closes`). See docs/194 "Where this respects the multi-PR thread."
 *
 * The pointer is the same tracker-neutral form `shipit issue` understands
 * (`SHI-43`, `owner/repo#42`, or a full Linear/GitHub issue URL), parsed by the
 * shared {@link parseIssueRef}. A token whose shape doesn't resolve to a known
 * tracker is ignored. We deliberately do NOT support GitHub's bare `#42` form:
 * it's tracker-ambiguous without a repo and `parseIssueRef` doesn't accept it —
 * keeping one uniform pointer vocabulary across both trackers.
 *
 * This is pure and tracker-agnostic so it can be unit-tested in isolation and
 * reused by the orchestrator merge path without dragging in tracker plumbing.
 */

import { parseIssueRef, type ParsedIssueRef } from "./issue-ref.js";

export interface PrBodyIssueRefs {
  /** Pointers under a closing keyword — flip to `completed` + comment on merge. */
  closes: ParsedIssueRef[];
  /** Pointers under a non-closing keyword — progress comment only on merge. */
  refs: ParsedIssueRef[];
}

// A closing keyword (GitHub's native set, case-insensitive): close/closes/closed,
// fix/fixes/fixed, resolve/resolves/resolved. Followed by an optional colon and
// the pointer token.
const CLOSE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+(\S+)/gi;
// A non-closing reference keyword: ref/refs/reference/references.
const REF_RE = /\b(?:references?|refs?)\b\s*:?\s+(\S+)/gi;

/** Strip surrounding markdown/punctuation noise from a captured pointer token. */
function cleanToken(raw: string): string {
  // Drop a trailing sentence punctuation (`Closes SHI-43.`) and any wrapping
  // parens/brackets/backticks/quotes a body might put around the pointer.
  return raw.replace(/^[([`"']+/, "").replace(/[).,;:!?\]`"']+$/, "");
}

/**
 * Collect the resolvable pointers following each occurrence of `re` in `body`,
 * de-duplicated by `tracker:issueId`. Tokens that don't resolve to a known
 * tracker (unknown shape) are dropped.
 */
function collect(body: string, re: RegExp, seen: Set<string>): ParsedIssueRef[] {
  const out: ParsedIssueRef[] = [];
  for (const match of body.matchAll(re)) {
    const token = cleanToken(match[1] ?? "");
    if (!token) continue;
    const parsed = parseIssueRef(token);
    if (parsed.tracker === "unknown" || !parsed.issueId) continue;
    const key = `${parsed.tracker}:${parsed.issueId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

/**
 * Parse a PR body into its closing and non-closing issue references. A pointer
 * that appears under both a closing and a non-closing keyword resolves to
 * **closing** (the stronger intent wins) — it is omitted from `refs`.
 */
export function parsePrBodyIssueRefs(body: string | null | undefined): PrBodyIssueRefs {
  if (!body) return { closes: [], refs: [] };
  // One shared `seen` set across both passes, closing first, so a pointer named
  // by both keywords lands only in `closes`.
  const seen = new Set<string>();
  const closes = collect(body, CLOSE_RE, seen);
  const refs = collect(body, REF_RE, seen);
  return { closes, refs };
}
