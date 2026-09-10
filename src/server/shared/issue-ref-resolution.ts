import type { TrackerId } from "./types/domain-types/issue.js";
import type { TrackerDestination } from "./declared-tracker.js";
import {
  isGitHubTracker,
  isLinearTracker,
  normalizeLinearTeamKey,
  parseGitHubTrackerId,
  parseLinearTrackerId,
} from "./tracker-id.js";
import { formatIssueReference, parseIssueRef, type ParsedIssueRef } from "./issue-ref.js";

export interface ResolvedIssueRef {
  tracker: TrackerId;
  trackerName?: string;
  identifier: string;
  issueId: string;
  url?: string;
}

export type IssueRefFailure =
  | "unrecognized"
  | "undeclared"
  | "ambiguous"
  | "mismatched";

export type IssueRefResolution =
  | { ok: true; ref: ResolvedIssueRef }
  | { ok: false; reason: IssueRefFailure; message: string; identifier: string };

export type TrackerDestinations = readonly TrackerDestination[];

function keyEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export function describeDeclaredNames(destinations: TrackerDestinations): string {
  const trackerNames = destinations
    .filter((d) => d.origin !== "plugin")
    .map((d) => d.name)
    .filter((n): n is string => Boolean(n));
  const pluginNames = destinations.flatMap((d) => d.pluginNames ?? []);
  const trackers =
    trackerNames.length > 0
      ? `Declared trackers: ${trackerNames.join(", ")}.`
      : "This repository declares no issue trackers — add an `issues.trackers` entry to shipit.yaml.";
  if (pluginNames.length === 0) return trackers;
  return `${trackers} Declared plugin repositories, for feedback on the plugin itself: ${pluginNames.join(", ")}.`;
}

export function matchedDestinationName(
  destination: TrackerDestination,
  asTyped: string,
): string | undefined {
  const needle = asTyped.trim().toLowerCase();
  return destination.pluginNames?.find((n) => n.toLowerCase() === needle) ?? destination.name;
}

export function resolveDestinationByName(
  destinations: TrackerDestinations,
  name: string,
): { ok: true; destination: TrackerDestination } | { ok: false; reason: IssueRefFailure; message: string } {
  const needle = name.trim().toLowerCase();
  const matches = destinations.filter(
    (d) =>
      d.name?.toLowerCase() === needle ||
      d.pluginNames?.some((p) => p.toLowerCase() === needle),
  );
  if (matches.length === 1) return { ok: true, destination: matches[0] };
  if (matches.length === 0) {
    return {
      ok: false,
      reason: "undeclared",
      message: `No issue tracker named \`${name}\` is declared in this repository's shipit.yaml. ${describeDeclaredNames(destinations)}`,
    };
  }
  return {
    ok: false,
    reason: "ambiguous",
    message: `\`${name}\` is declared more than once in this repository's shipit.yaml — names must be unique.`,
  };
}

export function resolveIssueRef(
  raw: string,
  destinations: TrackerDestinations,
): IssueRefResolution {
  return resolveParsedIssueRef(parseIssueRef(raw), destinations);
}

export function resolveParsedIssueRef(
  parsed: ParsedIssueRef,
  destinations: TrackerDestinations,
): IssueRefResolution {
  const identifier = parsed.identifier;

  if (parsed.trackerName) {
    const found = resolveDestinationByName(destinations, parsed.trackerName);
    if (!found.ok) return { ok: false, reason: found.reason, message: found.message, identifier };
    return resolveNamedSuffix(found.destination, parsed.trackerName, parsed.issueId ?? "", identifier);
  }

  if (parsed.tracker === "unknown" || !parsed.issueId) {
    return {
      ok: false,
      reason: "unrecognized",
      message:
        `\`${identifier}\` is not a recognized issue reference. Use a declared tracker's name ` +
        `(\`planning#42\`, \`roadmap#SHI-304\`) or the backend's own address ` +
        `(\`owner/repo#42\`, \`SHI-304\`, an issue URL).`,
      identifier,
    };
  }

  const declared = destinations.filter((d) => d.name && canonicalMatches(d, parsed.tracker as TrackerId));
  if (declared.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message:
        `\`${identifier}\` matches more than one declared tracker ` +
        `(${declared.map((d) => d.name).join(", ")}), so ShipIt cannot tell which one it means. ` +
        `Address it by name instead.`,
      identifier,
    };
  }
  if (declared.length === 1) {
    const destination = declared[0];
    return {
      ok: true,
      ref: {
        tracker: destination.id,
        ...(destination.name ? { trackerName: destination.name } : {}),
        identifier: formatIssueReference({
          trackerName: destination.name,
          kind: destination.kind,
          key: destination.key,
          issueId: parsed.issueId,
        }),
        issueId: parsed.issueId,
        ...(parsed.url ? { url: parsed.url } : {}),
      },
    };
  }

  // Prefer a declaration of the session's own repo over its unnamed fallback.
  const own = destinations.find((d) => !d.name && canonicalMatches(d, parsed.tracker as TrackerId));
  if (own) {
    return {
      ok: true,
      ref: {
        tracker: own.id,
        identifier,
        issueId: parsed.issueId,
        ...(parsed.url ? { url: parsed.url } : {}),
      },
    };
  }

  return {
    ok: false,
    reason: "undeclared",
    message:
      `\`${identifier}\` names a destination this repository does not declare, and ShipIt has no ` +
      `implicit tracker to fall back to. ${describeDeclaredNames(destinations)}`,
    identifier,
  };
}

function canonicalMatches(dest: TrackerDestination, id: TrackerId): boolean {
  if (isGitHubTracker(id)) {
    if (dest.kind !== "github") return false;
    const ref = parseGitHubTrackerId(id);
    if (!ref) return false;
    return keyEquals(dest.key, `${ref.owner}/${ref.repo}`);
  }
  if (isLinearTracker(id)) {
    if (dest.kind !== "linear") return false;
    const team = parseLinearTrackerId(id);
    if (!team) return false;
    return keyEquals(dest.key, team);
  }
  return false;
}

function resolveNamedSuffix(
  destination: TrackerDestination,
  name: string,
  suffix: string,
  identifier: string,
): IssueRefResolution {
  const fail = (message: string): IssueRefResolution => ({
    ok: false,
    reason: "mismatched",
    message,
    identifier,
  });

  let issueId: string;
  if (destination.kind === "github") {
    if (!/^\d+$/.test(suffix)) {
      return fail(
        `\`${identifier}\` names the GitHub tracker \`${name}\`, whose issues are numbered — ` +
          `\`${suffix}\` is not an issue number.`,
      );
    }
    issueId = suffix;
  } else {
    const team = normalizeLinearTeamKey(destination.key ?? "");
    if (!team) {
      return fail(`The Linear tracker \`${name}\` has no usable team key in its declaration.`);
    }
    const keyed = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(suffix);
    // The current declaration wins over a stale team prefix. Undo bypasses this resolver.
    issueId = keyed ? `${team}-${keyed[2]}` : `${team}-${suffix}`;
  }

  const resolvedName = matchedDestinationName(destination, name) ?? name;
  return {
    ok: true,
    ref: {
      tracker: destination.id,
      trackerName: resolvedName,
      identifier: formatIssueReference({
        trackerName: resolvedName,
        kind: destination.kind,
        key: destination.key,
        issueId,
      }),
      issueId,
    },
  };
}
