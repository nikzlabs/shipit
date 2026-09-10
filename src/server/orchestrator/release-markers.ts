import type { ReleaseBumpType, ReleaseMechanism } from "../shared/types/release-types.js";

export interface ReleaseProposeMarker {
  action: "propose";
  version: string;
  tag: string;
  prerelease: boolean;
  bumpType?: ReleaseBumpType;
  versionSource?: string;
  mechanism?: ReleaseMechanism;
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

export interface ReleasePrOpenedMarker {
  action: "pr-opened";
  version: string;
  tag: string;
  prNumber: number;
  prUrl: string;
  releaseBranch: string;
  prerelease?: boolean;
  bumpType?: ReleaseBumpType;
  versionSource?: string;
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
  | ReleasePrOpenedMarker
  | ReleaseTaggedMarker
  | ReleaseAlreadyReleasedMarker
  | ReleaseCancelledMarker;

const MARKER_RE = /<!--\s*shipit:release\s*(\{[\s\S]*?\})\s*-->/g;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const BUMP_TYPES: ReadonlySet<string> = new Set(["major", "minor", "patch", "prerelease"]);
const MECHANISMS: ReadonlySet<string> = new Set(["tag-triggered", "brokered", "release-branch"]);

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
      const mechanism = asString(raw.mechanism);
      out.push({
        action: "propose",
        version,
        tag,
        prerelease: raw.prerelease === true,
        ...(bump && BUMP_TYPES.has(bump) ? { bumpType: bump as ReleaseBumpType } : {}),
        ...(asString(raw.versionSource) ? { versionSource: asString(raw.versionSource)! } : {}),
        ...(mechanism && MECHANISMS.has(mechanism) ? { mechanism: mechanism as ReleaseMechanism } : {}),
        ...(asString(raw.notes) ? { notes: asString(raw.notes)! } : {}),
      });
    } else if (action === "pr-opened") {
      const version = asString(raw.version);
      const tag = asString(raw.tag);
      const prUrl = asString(raw.prUrl);
      const releaseBranch = asString(raw.releaseBranch);
      const prNumber = typeof raw.prNumber === "number" ? raw.prNumber : Number(asString(raw.prNumber));
      if (!version || !tag || !prUrl || !releaseBranch || !Number.isInteger(prNumber) || prNumber <= 0) continue;
      const bump = asString(raw.bumpType);
      out.push({
        action: "pr-opened",
        version,
        tag,
        prNumber,
        prUrl,
        releaseBranch,
        ...(typeof raw.prerelease === "boolean" ? { prerelease: raw.prerelease } : {}),
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
