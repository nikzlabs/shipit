/**
 * Where an agent-authored preview pointer should send a live iframe (docs/258).
 *
 * Extracted from `PreviewFrame` because the decision is the interesting part and
 * the component around it is not testable in isolation: an iframe pool, a health
 * poller and a postMessage bridge stand between the click and this comparison.
 */

export type PointerNavigation =

  | { kind: "navigate"; url: string }

  | { kind: "already-there" }

  | { kind: "outside-preview" };

export function resolvePointerNavigation(
  targetPath: string,
  slotUrl: string,
  reportedPath: string | undefined,
): PointerNavigation {
  try {
    const origin = new URL(slotUrl).origin;
    const destination = new URL(targetPath, slotUrl);

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
