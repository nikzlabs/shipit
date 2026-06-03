/**
 * Release markers (docs/171 Phase 1) — the agent communicates a release
 * proposal and its outcome by emitting a small structured comment marker in
 * its turn text ("computed by the agent during the turn and emitted as part of
 * the turn, then mirrored into the card"). This module parses those markers
 * out of the accumulated assistant text after a turn.
 *
 * Why a marker rather than a new agent tool / `gh` shim change: the MVP needs
 * **no** new container-side capability (docs/171 "Agent backends"). The marker
 * is an HTML comment so it stays invisible in the rendered chat, is agent-
 * agnostic (Claude + Codex both emit plain text), and carries a JSON payload
 * that's robust to quoting/newlines in the notes.
 *
 * Marker shape (one per line, JSON payload):
 *
 *   <!--shipit:release {"action":"propose","version":"0.3.0","bumpType":"minor",
 *     "tag":"v0.3.0","prerelease":false,"notes":"..."}-->
 *   <!--shipit:release {"action":"tagged","tag":"v0.3.0","version":"0.3.0","sha":"abc123"}-->
 *   <!--shipit:release {"action":"already-released","tag":"v0.3.0","version":"0.3.0"}-->
 *   <!--shipit:release {"action":"cancelled"}-->
 */

import type { ReleaseBumpType } from "../shared/types/release-types.js";

export interface ReleaseProposeMarker {
  action: "propose";
  version: string;
  tag: string;
  prerelease: boolean;
  bumpType?: ReleaseBumpType;
  versionSource?: string;
  notes?: string;
}

export interface ReleaseTaggedMarker {
  action: "tagged";
  tag: string;
  version?: string;
  sha?: string;
  prerelease?: boolean;
  notes?: string;
}

export interface ReleaseAlreadyReleasedMarker {
  action: "already-released";
  tag: string;
  version?: string;
}

export interface ReleaseCancelledMarker {
  action: "cancelled";
}

export type ReleaseMarker =
  | ReleaseProposeMarker
  | ReleaseTaggedMarker
  | ReleaseAlreadyReleasedMarker
  | ReleaseCancelledMarker;

const MARKER_RE = /<!--\s*shipit:release\s*(\{[\s\S]*?\})\s*-->/g;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const BUMP_TYPES: ReadonlySet<string> = new Set(["major", "minor", "patch", "prerelease"]);

/**
 * Parse all release markers from a block of turn text, in document order.
 * Malformed markers (bad JSON, unknown/absent `action`, missing required
 * fields) are skipped silently — a half-typed marker must never half-drive the
 * card. Callers typically act on the LAST marker of each action.
 */
export function parseReleaseMarkers(text: string): ReleaseMarker[] {
  if (!text?.includes("shipit:release")) return [];
  const out: ReleaseMarker[] = [];
  for (const match of text.matchAll(MARKER_RE)) {
    const json = match[1];
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const action = asString(raw.action);
    if (!action) continue;

    if (action === "propose") {
      const version = asString(raw.version);
      const tag = asString(raw.tag);
      if (!version || !tag) continue;
      const bump = asString(raw.bumpType);
      out.push({
        action: "propose",
        version,
        tag,
        prerelease: raw.prerelease === true,
        ...(bump && BUMP_TYPES.has(bump) ? { bumpType: bump as ReleaseBumpType } : {}),
        ...(asString(raw.versionSource) ? { versionSource: asString(raw.versionSource)! } : {}),
        ...(asString(raw.notes) ? { notes: asString(raw.notes)! } : {}),
      });
    } else if (action === "tagged") {
      const tag = asString(raw.tag);
      if (!tag) continue;
      out.push({
        action: "tagged",
        tag,
        ...(asString(raw.version) ? { version: asString(raw.version)! } : {}),
        ...(asString(raw.sha) ? { sha: asString(raw.sha)! } : {}),
        ...(typeof raw.prerelease === "boolean" ? { prerelease: raw.prerelease } : {}),
        ...(asString(raw.notes) ? { notes: asString(raw.notes)! } : {}),
      });
    } else if (action === "already-released") {
      const tag = asString(raw.tag);
      if (!tag) continue;
      out.push({
        action: "already-released",
        tag,
        ...(asString(raw.version) ? { version: asString(raw.version)! } : {}),
      });
    } else if (action === "cancelled") {
      out.push({ action: "cancelled" });
    }
  }
  return out;
}
