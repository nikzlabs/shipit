import { getLocalStorageObject } from "../utils/local-storage.js";

/**
 * Per-session memory of which preview the user chose to look at.
 *
 * Mirrors `viewport-memory.ts` (docs/278) in every mechanical respect: a
 * localStorage-backed `Record<sessionId, entry>` hydrated once into the preview
 * store, written through on every selection, LRU-capped, and validated on load
 * so a tampered blob degrades to "no memory" rather than a broken pane.
 *
 * **The entry is keyed by service NAME, not by port.** A port is a fact about
 * the present — the panel's `selectedPort` is derived from it and is cleared
 * whenever the chosen service is not currently running, which is precisely how
 * a switch away and back (idle container reclaimed, services rebooting one by
 * one) used to snap the pane onto whichever service happened to come up first.
 * The name survives all of that, so the choice can be re-derived the moment the
 * service is running again.
 *
 * `port` is the fallback handle for a preview no Compose service owns — a
 * Vite-detected or `managed` port — where the number is the only identity there
 * is.
 */
export interface PersistedPreviewTarget {
  /** The Compose service the user chose, when one owned the port. */
  service?: string;
  /** The port chosen. Authoritative only when `service` is absent. */
  port: number;
}

export const PREVIEW_TARGET_MEMORY_KEY = "shipit:preview-target";

/**
 * Cap on remembered sessions. Same order as `MAX_REMEMBERED_VIEWPORTS`: bounds
 * growth across a long-lived session list, evicting oldest-first (plain-object
 * key order is insertion order for these non-numeric keys; writes re-insert).
 */
export const MAX_REMEMBERED_TARGETS = 100;

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65_536;
}

/**
 * Narrow one untrusted entry to a usable {@link PersistedPreviewTarget}, or
 * null. A missing/invalid port drops the entry whole even when the service name
 * is fine: the port is what the pane routes to before the service list arrives.
 */
export function sanitizePreviewTargetEntry(raw: unknown): PersistedPreviewTarget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as { service?: unknown; port?: unknown };
  if (!isValidPort(entry.port)) return null;
  if (entry.service !== undefined && (typeof entry.service !== "string" || !entry.service)) return null;
  return entry.service ? { service: entry.service, port: entry.port } : { port: entry.port };
}

export function loadPreviewTargetMemory(): Record<string, PersistedPreviewTarget> {
  return getLocalStorageObject<Record<string, PersistedPreviewTarget>>(
    PREVIEW_TARGET_MEMORY_KEY,
    {},
    (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, PersistedPreviewTarget> = {};
      // Trailing entries are the most recent (writes re-insert at the end), so
      // an oversized blob is truncated from the front rather than loaded whole.
      const entries = Object.entries(parsed as Record<string, unknown>).slice(-MAX_REMEMBERED_TARGETS);
      for (const [key, value] of entries) {
        const entry = sanitizePreviewTargetEntry(value);
        if (entry) out[key] = entry;
      }
      return out;
    },
  );
}

export function savePreviewTargetMemory(map: Record<string, PersistedPreviewTarget>): void {
  try {
    localStorage.setItem(PREVIEW_TARGET_MEMORY_KEY, JSON.stringify(map));
  } catch {
    /* localStorage unavailable — memory degrades to per-tab */
  }
}

/**
 * The map with `sessionId`'s entry updated (re-inserted at the end so eviction
 * is LRU), deleted (null entry), and capped.
 */
export function withPreviewTargetEntry(
  map: Record<string, PersistedPreviewTarget>,
  sessionId: string,
  entry: PersistedPreviewTarget | null,
): Record<string, PersistedPreviewTarget> {
  const { [sessionId]: _dropped, ...rest } = map;
  if (!entry) return rest;
  const entries = Object.entries(rest);
  const kept =
    entries.length >= MAX_REMEMBERED_TARGETS
      ? entries.slice(entries.length - MAX_REMEMBERED_TARGETS + 1)
      : entries;
  return { ...Object.fromEntries(kept), [sessionId]: entry };
}
