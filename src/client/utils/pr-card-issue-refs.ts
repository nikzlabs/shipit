/**
 * Combine the issue pointers a PR card should surface, from the two sources
 * that are already available client-side (docs/206) — no server round-trip:
 *
 *  - **PR body** — `Closes`/`Fixes`/`Resolves` (→ `closes`) and `Refs`/
 *    `References` (→ `refs`), via the shared {@link parsePrBodyIssueRefs}.
 *  - **Session origin** — the issue a session was started from, recovered from
 *    its first user message via the shared {@link extractIssueRefsFromText}
 *    (→ `origin`).
 *
 * The lists are merged and deduped by `tracker:issueId`. When the same issue
 * shows up under more than one source, the **strongest intent wins**
 * (`closes` > `refs` > `origin`) — a PR that both closes an issue and was
 * started from it reads as `Closes`. Result order is closing pointers first,
 * then refs, then origin, so the most committal links lead the chip row.
 */

import type { ParsedIssueRef } from "../../server/shared/issue-ref.js";
import { extractIssueRefsFromText } from "../../server/shared/issue-ref.js";
import { parsePrBodyIssueRefs } from "../../server/shared/pr-issue-refs.js";

/** Where a chip's pointer came from, in increasing strength. */
export type IssueIntent = "origin" | "refs" | "closes";

export interface IssueChipRef extends ParsedIssueRef {
  intent: IssueIntent;
}

const INTENT_RANK: Record<IssueIntent, number> = { origin: 1, refs: 2, closes: 3 };

export function collectPrCardIssueRefs(args: {
  prBody?: string | null;
  firstUserMessage?: string | null;
}): IssueChipRef[] {
  const { closes, refs } = parsePrBodyIssueRefs(args.prBody);
  const origin = extractIssueRefsFromText(args.firstUserMessage);

  // Map preserves first-insertion order even when a key is re-set, so iterating
  // closes → refs → origin yields that display order; the rank guard prevents a
  // weaker later source from downgrading a stronger earlier one.
  const byKey = new Map<string, IssueChipRef>();
  const consider = (ref: ParsedIssueRef, intent: IssueIntent) => {
    if (!ref.issueId) return;
    const key = `${ref.tracker}:${ref.issueId}`;
    const existing = byKey.get(key);
    if (existing && INTENT_RANK[existing.intent] >= INTENT_RANK[intent]) return;
    byKey.set(key, { ...ref, intent });
  };

  closes.forEach((r) => consider(r, "closes"));
  refs.forEach((r) => consider(r, "refs"));
  origin.forEach((r) => consider(r, "origin"));

  return [...byKey.values()];
}
