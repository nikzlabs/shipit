/**
 * agent-auth-base.ts — transport-agnostic helpers shared by every per-agent
 * auth manager (Claude's OAuth PTY flow, Codex's RFC-8628 device flow).
 *
 * docs/201 P3 + cross-cutting finding B: the Claude (`claude/auth-manager.ts`)
 * and Codex (`codex/auth-manager.ts`) managers had independently re-implemented
 * the same credential-file parsing — probing a token/expiry across the
 * top-level *and* a nested wrapper object the CLI's `auth.json`/`.credentials.json`
 * has carried across versions — plus the identical "resolve a symlinked config
 * dir before mkdir" dance Docker forces on us. A bug fix in one had to be
 * hand-ported to the other, and a third backend meant copying it again.
 *
 * These are the de-duplicated primitives. Each manager keeps only its
 * transport-specific code (PTY readline / Ink prompts vs device-code polling)
 * and a thin wrapper that names *its own* credential-file keys; the parsing and
 * filesystem mechanics live here. Pure and side-effect-free except
 * {@link ensureConfigDir}, which is the one filesystem touch.
 */

import { mkdirSync, readlinkSync } from "node:fs";

/** A non-empty string at `obj[key]`, else `null`. */
export function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * The first non-empty string among `keys` at the top level of `obj`, then —
 * when `nested` is given and `obj[nested]` is an object — among `nestedKeys`
 * (defaulting to `keys`) inside it. Returns `null` when nothing matches.
 *
 * Covers both on-disk credential shapes the CLIs have written across versions:
 * a top-level token, or one nested under a wrapper object (`claudeAiOauth` for
 * Claude, `tokens` for Codex). Key order is honored, so callers pass their
 * preferred alias first.
 */
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

/**
 * The first value among `candidates` that parses as a positive timestamp,
 * normalized to **epoch milliseconds**. Tolerates epoch-seconds inputs (some
 * refresh-token responses return seconds) via a magnitude heuristic: a value
 * too small to be a recent millisecond timestamp is treated as seconds and
 * scaled up. Returns `null` when none parse.
 */
export function firstEpochMs(candidates: readonly unknown[]): number | null {
  for (const raw of candidates) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw < 10_000_000_000 ? raw * 1000 : raw;
    }
  }
  return null;
}

/**
 * Resolve a config dir to the path that should actually be created. In Docker
 * the singleton dirs (`/root/.claude`, `/root/.codex`) are symlinks into the
 * `/credentials` volume; `mkdirSync` on a *broken* symlink errors, so return
 * the link target and create that instead. A real directory (or a
 * non-existent path) makes `readlinkSync` throw, so we return the input
 * unchanged. Account-scoped dirs (docs/150) are real directories and take this
 * second path.
 */
export function resolveSymlinkTarget(dir: string): string {
  try {
    return readlinkSync(dir);
  } catch {
    // Not a symlink (or doesn't exist) — use the path directly.
    return dir;
  }
}

/**
 * `mkdir -p` the config dir, dereferencing a symlink first (see
 * {@link resolveSymlinkTarget}). Never throws — logs under `logPrefix` and
 * swallows, since a failure here just means the subsequent credential write
 * will surface the real error.
 */
export function ensureConfigDir(configDir: string, logPrefix: string): void {
  try {
    mkdirSync(resolveSymlinkTarget(configDir), { recursive: true });
  } catch (err) {
    console.warn(`${logPrefix} Failed to create config dir:`, err);
  }
}
