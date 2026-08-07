/**
 * Combine the issue references a PR card should surface, from the two sources
 * that are already available client-side (docs/206) — no server round-trip:
 *
 *  - **PR body** — `Closes`/`Fixes`/`Resolves` (→ `closes`) and `Refs`/
 *    `References` (→ `refs`), via the shared {@link parsePrBodyIssueRefs}.
 *  - **Session origin** — the issue a session was started from, recovered from
 *    its first user message via the shared {@link extractIssueRefsFromText}
 *    (→ `origin`).
 *
 * Each reference is then resolved against the destinations this session can
 * reach (docs/248 req 11), so the chip knows whether there is an inline view to
 * open. A reference that names nothing declared still renders — it is what the
 * PR body says, and hiding it would be worse than showing it — but as a legible
 * badge rather than a link into a tracker ShipIt cannot reach.
 *
 * The lists are merged and deduped by destination + id (falling back to the
 * display identifier for an unresolved one). When the same issue shows up under
 * more than one source, the **strongest intent wins** (`closes` > `refs` >
 * `origin`) — a PR that both closes an issue and was started from it reads as
 * `Closes`. Result order is closing references first, then refs, then origin, so
 * the most committal links lead the chip row.
 */

import type { ParsedIssueRef } from "../../server/shared/issue-ref.js";
import { extractIssueRefsFromText } from "../../server/shared/issue-ref.js";
import { parsePrBodyIssueRefs } from "../../server/shared/pr-issue-refs.js";
import { resolveParsedIssueRef } from "../../server/shared/issue-ref-resolution.js";
import type { TrackerDestination } from "../../server/shared/declared-tracker.js";
import type { TrackerId } from "../../server/shared/types.js";

/** Where a chip's reference came from, in increasing strength. */
export type IssueIntent = "origin" | "refs" | "closes";

export interface IssueChipRef {
  intent: IssueIntent;
  /** Display form — the name form when the destination has one (req 15). */
  identifier: string;
  /**
   * The resolved destination. Absent when the reference names nothing this
   * repository declares: the chip then renders as a static badge (or an external
   * link when the reference carried a URL) rather than opening an inline view
   * that would fail (req 11).
   */
  tracker?: TrackerId;
  issueId?: string;
  url?: string;
}

const INTENT_RANK: Record<IssueIntent, number> = { origin: 1, refs: 2, closes: 3 };

export function collectPrCardIssueRefs(args: {
  prBody?: string | null;
  firstUserMessage?: string | null;
  destinations?: TrackerDestination[];
}): IssueChipRef[] {
  const { closes, refs } = parsePrBodyIssueRefs(args.prBody);
  const origin = extractIssueRefsFromText(args.firstUserMessage);
  const destinations = args.destinations ?? [];

  // Map preserves first-insertion order even when a key is re-set, so iterating
  // closes → refs → origin yields that display order; the rank guard prevents a
  // weaker later source from downgrading a stronger earlier one.
  const byKey = new Map<string, IssueChipRef>();
  const consider = (ref: ParsedIssueRef, intent: IssueIntent) => {
    if (!ref.issueId) return;
    const resolution = resolveParsedIssueRef(ref, destinations);
    const chip: IssueChipRef = resolution.ok
      ? {
          intent,
          identifier: resolution.ref.identifier,
          tracker: resolution.ref.tracker,
          issueId: resolution.ref.issueId,
          ...(resolution.ref.url ? { url: resolution.ref.url } : {}),
        }
      : { intent, identifier: ref.identifier, ...(ref.url ? { url: ref.url } : {}) };
    const key = chip.tracker ? `${chip.tracker}:${chip.issueId}` : chip.identifier;
    const existing = byKey.get(key);
    if (existing && INTENT_RANK[existing.intent] >= INTENT_RANK[intent]) return;
    byKey.set(key, chip);
  };

  closes.forEach((r) => consider(r, "closes"));
  refs.forEach((r) => consider(r, "refs"));
  origin.forEach((r) => consider(r, "origin"));

  return [...byKey.values()];
}
