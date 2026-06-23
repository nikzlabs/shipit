/**
 * Shared lazy fetch for a presentation's bytes (docs/093). The Present tab keeps
 * METADATA only; the artifact bytes are fetched on demand from the authenticated
 * session API and cached back onto the store entry via `setContent`. The single
 * artifact view (PresentPane) fetches the active entry; the thumbnail gallery
 * (PresentGallery) fetches each tile as it scrolls into view — both go through
 * here so the in-flight de-dupe and the "already cached" short-circuit are shared.
 */

import { usePresentStore } from "../stores/present-store.js";

/** Session+id pairs with an in-flight fetch, so concurrent callers don't double-fetch. */
const inFlight = new Set<string>();

/**
 * Fetch and cache the bytes for one presentation. No-op when the session/id is
 * missing, the entry is gone, the bytes are already cached, or a fetch for the
 * same pair is already running. Errors are swallowed: the gallery tile shows a
 * blank/placeholder preview rather than an error chrome (the single view owns
 * the user-facing error message).
 */
export async function loadPresentContent(sessionId: string, presentId: string): Promise<void> {
  if (!sessionId || !presentId) return;
  const entry = usePresentStore.getState().presentations.find((p) => p.presentId === presentId);
  if (!entry || entry.content !== undefined) return;
  const key = `${sessionId}:${presentId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const res = await fetch(`/api/sessions/${sessionId}/present/${presentId}/content`);
    const body = (await res.json().catch(() => ({}))) as { content?: string };
    if (res.ok && typeof body.content === "string") {
      usePresentStore.getState().setContent(presentId, body.content);
    }
  } catch {
    // Best-effort — the tile stays on its placeholder.
  } finally {
    inFlight.delete(key);
  }
}
