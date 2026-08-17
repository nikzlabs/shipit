/**
 * Tracker-issue link detection for markdown surfaces (chat, docs, PR bodies).
 *
 * A Linear or GitHub *issue* URL written in rendered markdown — either as an
 * explicit `[label](url)` link or autolinked from bare prose by `remark-gfm` —
 * is data ShipIt already renders inline (the master-detail Issues panel). Per
 * the "inline beats link-out" product principle (CLAUDE.md §1/§2), clicking
 * such a link should open the in-app issue viewer rather than bouncing the user
 * out to linear.app / github.com. This classifies an href so `MarkdownLink` can
 * route the click; the viewer-opening lives at the call site.
 *
 * We deliberately reuse the shared reference resolver — the same one the
 * `shipit issue` shim uses — so the client and server agree both on what is an
 * issue URL and on whether it is *reachable*. The parser's regexes already
 * distinguish issue URLs from PR / project / repo URLs: a GitHub `/pull/N`, a
 * Linear project URL, or a plain external link all fail to parse and are
 * returned as `null` here — they keep opening externally, unchanged.
 *
 * docs/248-declared-issue-trackers req 11 — recognizing an address is not the same as reaching it. A
 * `github.com/other/repo/issues/9` URL for a repository this session's
 * repository does not declare has no in-app view to open, so it also returns
 * `null` and keeps its ordinary external link. That is the fail-closed-but-
 * legible behavior: never a broken in-app link, never a silent redirect to some
 * other tracker.
 */
import type { TrackerDestination } from "../../server/shared/declared-tracker.js";
import { resolveIssueRef } from "../../server/shared/issue-ref-resolution.js";
import type { TrackerId } from "../../server/shared/types.js";

export interface TrackerIssueLink {
  tracker: TrackerId;
  /** Display identifier, e.g. "SHI-28", "owner/repo#42", "planning#42". */
  identifier: string;
  /** Tracker-native lookup id (Linear key, bare GitHub number). */
  issueId?: string;
  /** Absolute URL to the issue — the external escape-hatch href. */
  url: string;
}

/**
 * Classify a markdown link href. Returns a resolved tracker-issue reference when
 * the href is a Linear/GitHub *issue* URL (or the GitHub `owner/repo#N` short
 * form) that resolves to a destination this session can reach, or `null` for
 * anything else — non-issue tracker URLs, undeclared destinations, repo file
 * paths, plain external links, in-page anchors.
 *
 * A usable absolute `url` is required, so a bare Linear key (`SHI-28`) or a
 * docs/248 name form (`planning#42`) is intentionally NOT intercepted here — it
 * would have no external fallback, and neither shape appears as an href anyway.
 */
export function parseTrackerIssueLink(
  href: string | undefined | null,
  destinations: TrackerDestination[],
): TrackerIssueLink | null {
  if (!href) return null;
  const resolution = resolveIssueRef(href, destinations);
  if (!resolution.ok) return null;
  const ref = resolution.ref;
  if (!ref.url) return null;
  return {
    tracker: ref.tracker,
    identifier: ref.identifier,
    issueId: ref.issueId,
    url: ref.url,
  };
}
