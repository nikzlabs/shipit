import { getLocalStorageObject } from "../utils/local-storage.js";
import {
  CUSTOM_SIZE_MIN,
  CUSTOM_SIZE_MAX,
  customPreset,
  findPresetById,
  type DevicePreset,
} from "../components/device-presets.js";

export type PersistedViewport =

  | { preset: string; landscape?: boolean }
  /** A freeform size, stored as rendered (custom sizes never carry landscape). */
  | { custom: { width: number; height: number } };

export interface ViewportState {
  devicePreset: DevicePreset | null;
  isLandscape: boolean;
  customSize: { width: number; height: number } | null;
}

export const VIEWPORT_MEMORY_KEY = "shipit:preview-viewport";

export const MAX_REMEMBERED_VIEWPORTS = 100;

function isValidCustomDim(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= CUSTOM_SIZE_MIN &&
    value <= CUSTOM_SIZE_MAX
  );
}

/**
 * Narrow one untrusted entry to a usable `PersistedViewport`, or null. A named
 * preset must still exist in the catalog (presets get renamed/retired by
 * updates); a custom size must be within the same bounds the typed inputs
 * enforce. Anything else is dropped whole — a half-valid entry restores as
 * Responsive rather than as a guess.
 */
export function sanitizeViewportEntry(raw: unknown): PersistedViewport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as { preset?: unknown; landscape?: unknown; custom?: unknown };
  if (typeof entry.preset === "string") {
    const preset = findPresetById(entry.preset);
    if (!preset || preset.id === "custom") return null;
    return entry.landscape === true ? { preset: preset.id, landscape: true } : { preset: preset.id };
  }
  if (entry.custom && typeof entry.custom === "object" && !Array.isArray(entry.custom)) {
    const { width, height } = entry.custom as { width?: unknown; height?: unknown };
    if (isValidCustomDim(width) && isValidCustomDim(height)) {
      return { custom: { width, height } };
    }
  }
  return null;
}

export function loadViewportMemory(): Record<string, PersistedViewport> {
  return getLocalStorageObject<Record<string, PersistedViewport>>(
    VIEWPORT_MEMORY_KEY,
    {},
    (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, PersistedViewport> = {};

      const entries = Object.entries(parsed as Record<string, unknown>).slice(
        -MAX_REMEMBERED_VIEWPORTS,
      );
      for (const [key, value] of entries) {
        const entry = sanitizeViewportEntry(value);
        if (entry) out[key] = entry;
      }
      return out;
    },
  );
}

export function saveViewportMemory(map: Record<string, PersistedViewport>): void {
  try {
    localStorage.setItem(VIEWPORT_MEMORY_KEY, JSON.stringify(map));
  } catch {
    /* localStorage unavailable — memory degrades to per-tab */
  }
}

/**
 * The persisted form of the live viewport fields, or null for Responsive
 * (stored as absence). Custom sizes are stored as rendered and never carry
 * landscape — `toggleLandscape` swaps the stored dims for custom instead.
 */
export function viewportEntryFromState(state: ViewportState): PersistedViewport | null {
  if (!state.devicePreset) return null;
  if (state.devicePreset.category === "custom") {
    const size = state.customSize ?? {
      width: state.devicePreset.width,
      height: state.devicePreset.height,
    };
    return sanitizeViewportEntry({ custom: size });
  }
  return state.isLandscape
    ? { preset: state.devicePreset.id, landscape: true }
    : { preset: state.devicePreset.id };
}

export function viewportStateFromEntry(entry: PersistedViewport | undefined): ViewportState {
  if (entry && "preset" in entry) {
    const preset = findPresetById(entry.preset);
    if (preset) {
      return { devicePreset: preset, isLandscape: entry.landscape === true, customSize: null };
    }
  } else if (entry && "custom" in entry) {
    return {
      devicePreset: customPreset(entry.custom.width, entry.custom.height),
      isLandscape: false,
      customSize: { ...entry.custom },
    };
  }
  return { devicePreset: null, isLandscape: false, customSize: null };
}

export function withViewportEntry(
  map: Record<string, PersistedViewport>,
  sessionId: string,
  entry: PersistedViewport | null,
): Record<string, PersistedViewport> {
  const { [sessionId]: _dropped, ...rest } = map;
  if (!entry) return rest;
  const entries = Object.entries(rest);
  const kept =
    entries.length >= MAX_REMEMBERED_VIEWPORTS
      ? entries.slice(entries.length - MAX_REMEMBERED_VIEWPORTS + 1)
      : entries;
  return { ...Object.fromEntries(kept), [sessionId]: entry };
}
