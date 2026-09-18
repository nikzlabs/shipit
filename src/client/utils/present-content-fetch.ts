

import { usePresentStore } from "../stores/present-store.js";

const inFlight = new Set<string>();

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
