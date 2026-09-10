import { mkdirSync, readlinkSync } from "node:fs";

export function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function probeNestedString(
  obj: Record<string, unknown>,
  keys: readonly string[],
  nested?: string,
  nestedKeys: readonly string[] = keys,
): string | null {
  for (const k of keys) {
    const v = pickString(obj, k);
    if (v) return v;
  }
  if (nested) {
    const inner = obj[nested];
    if (inner && typeof inner === "object") {
      for (const k of nestedKeys) {
        const v = pickString(inner as Record<string, unknown>, k);
        if (v) return v;
      }
    }
  }
  return null;
}

/** Values below 10^10 are treated as epoch seconds. */
export function firstEpochMs(candidates: readonly unknown[]): number | null {
  for (const raw of candidates) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw < 10_000_000_000 ? raw * 1000 : raw;
    }
  }
  return null;
}

// mkdir on a broken credential symlink fails; create its target instead.
export function resolveSymlinkTarget(dir: string): string {
  try {
    return readlinkSync(dir);
  } catch {
    return dir;
  }
}

export function ensureConfigDir(configDir: string, logPrefix: string): void {
  try {
    mkdirSync(resolveSymlinkTarget(configDir), { recursive: true });
  } catch (err) {
    console.warn(`${logPrefix} Failed to create config dir:`, err);
  }
}
