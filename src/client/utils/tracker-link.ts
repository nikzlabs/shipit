/**
 * Tracker-issue link detection for markdown surfaces (chat, docs, PR bodies).
 *
 * A Linear or GitHub *issue* URL written in rendered markdown — either as an
 * explicit `[label](url)` link or autolinked from bare prose by `remark-gfm` —
 * is data ShipIt already renders inline (the master-detail Issues panel). Per
 * the "inline beats link-out" product principle (CLAUDE.md §1/§2), clicking
 * such a link should open the in-app issue viewer rather than bouncing the user
 * out to linear.app / github.com. This classifies an href so `MarkdownLink` can
 * route the click; the connected-tracker gating + viewer-opening live at the
 * call site.
 *
 * We deliberately reuse the shared `parseIssueRef` (the single pointer→tracker
 * resolver, also used by the server's `shipit issue` shim) so the client and
 * server agree on what is an issue URL. Its regexes already distinguish issue
 * URLs from PR / project / repo URLs: a GitHub `/pull/N`, a Linear project URL,
 * or a plain external link all resolve to `tracker: "unknown"` and are returned
 * as `null` here — they keep opening externally, unchanged.
 */
import { parseIssueRef } from "../../server/shared/issue-ref.js";

export interface TrackerIssueLink {
  tracker: "linear" | "github";
  /** Display identifier, e.g. "SHI-28" or "owner/repo#42". */
  identifier: string;
  /** Tracker-native lookup id (Linear key, bare GitHub number). */
  issueId?: string;
  /** Absolute URL to the issue — the external escape-hatch href. */
  url: string;
}

/**
 * Classify a markdown link href. Returns a parsed tracker-issue reference when
 * the href is a Linear/GitHub *issue* URL (or the GitHub `owner/repo#N` short
 * form), or `null` for anything else — non-issue tracker URLs, repo file paths,
 * plain external links, in-page anchors.
 *
 * A usable absolute `url` is required, so a bare Linear key (`SHI-28`, which has
 * no derivable URL without the workspace slug) is intentionally NOT intercepted
 * — it would have no external fallback and risks false positives on
 * relative-looking link text.
 */
export function parseTrackerIssueLink(href: string | undefined | null): TrackerIssueLink | null {
  if (!href) return null;
  const ref = parseIssueRef(href);
  if (ref.tracker === "unknown") return null;
  if (!ref.url) return null;
  return {
    tracker: ref.tracker,
    identifier: ref.identifier,
    ...(ref.issueId !== undefined ? { issueId: ref.issueId } : {}),
    url: ref.url,
  };
}
