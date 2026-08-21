/**
 * Where an agent-authored preview pointer should send a live iframe (docs/258).
 *
 * Extracted from `PreviewFrame` because the decision is the interesting part and
 * the component around it is not testable in isolation: an iframe pool, a health
 * poller and a postMessage bridge stand between the click and this comparison.
 */

export type PointerNavigation =
  /**
   * Send the frame to this URL. Whether that is a same-document hash change or
   * a new document is decided inside the frame, where the live `location` is
   * readable — this side only knows the page's last *reported* path.
   */
  | { kind: "navigate"; url: string }
  /** The page is already there; navigating would reload it for nothing. */
  | { kind: "already-there" }
  /** The destination resolves off the preview's origin — refuse and report. */
  | { kind: "outside-preview" };

/**
 * @param targetPath  the pointer's validated path, query and fragment
 * @param slotUrl     the iframe-pool slot's entry URL — where the page *started*
 * @param reportedPath  where the page says it IS now (`previewPaths`, written by
 *   the injected script on load and on every history change, so it tracks
 *   client-side routing). Absent when the page has not reported yet.
 *
 * The comparison is against `reportedPath`, not `slotUrl`, and that distinction
 * is the whole point. Comparing against the entry URL breaks both directions: a
 * slot created at `/x` whose app has since navigated to `/y` would refuse to go
 * back, and a slot created at `/` would reload the user's app on every repeat
 * click — discarding its state to perform a navigation the requirements say a
 * repeat click need not perform at all.
 */
export function resolvePointerNavigation(
  targetPath: string,
  slotUrl: string,
  reportedPath: string | undefined,
): PointerNavigation {
  try {
    const origin = new URL(slotUrl).origin;
    const destination = new URL(targetPath, slotUrl);
    // The parser already rejected everything that could escape the origin; this
    // re-checks the resolved value rather than inheriting that guarantee,
    // because what follows is an iframe navigation.
    if (destination.origin !== origin) return { kind: "outside-preview" };

    const current = reportedPath ? new URL(reportedPath, slotUrl) : new URL(slotUrl);
    if (current.origin === origin && current.href === destination.href) {
      return { kind: "already-there" };
    }
    return { kind: "navigate", url: destination.href };
  } catch {
    return { kind: "outside-preview" };
  }
}
