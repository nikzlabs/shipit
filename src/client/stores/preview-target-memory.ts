import { getLocalStorageObject } from "../utils/local-storage.js";

export interface PersistedPreviewTarget {

  service?: string;

  port: number;
}

export const PREVIEW_TARGET_MEMORY_KEY = "shipit:preview-target";

export const MAX_REMEMBERED_TARGETS = 100;

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65_536;
}

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
