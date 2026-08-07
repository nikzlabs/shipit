/**
 * Reference → destination resolution (docs/248 reqs 10, 11, 12, 16, 19).
 *
 * A thin layer **above** `parseIssueRef`, which stays pure and context-free. The
 * split is the design: the parser answers "what shape is this string", this
 * module answers "which declared tracker does that identify" — and because every
 * caller goes through here, requirement 11's two failure rules live in one place
 * rather than at each of the call sites:
 *
 *  - a reference identifying **no** declared destination fails closed, because
 *    requirement 1 leaves no destination outside the declarations except the
 *    session's own repository;
 *  - a reference matching **more than one** declaration is ambiguous and fails
 *    closed rather than resolving to one of them.
 *
 * Neither failure is ever downgraded to a guess. Callers surface the returned
 * message where the operation started (req 19): inline in the Issues UI for a
 * user action, in `shipit` CLI output for an agent action.
 *
 * **Resolution happens at use, not at write (req 16).** Nothing here consults a
 * destination recorded earlier; a `planning#42` written months ago resolves
 * through whatever `planning` names today. The single exception is undoing a
 * recorded write, which is deliberately *not* routed through this module — see
 * `services/issues.ts`'s undo path and req 11's carve-out.
 */

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

/** A reference that resolved to a reachable destination. */
export interface ResolvedIssueRef {
  /** The destination the operation must act on — used verbatim (req 17). */
  tracker: TrackerId;
  /** The declared name it resolved through, when the destination has one. */
  trackerName?: string;
  /**
   * Display form, in the **name** form whenever the destination has a name
   * (req 15). This is what ShipIt writes back into cards, branch names and CLI
   * output.
   */
  identifier: string;
  /** Tracker-native id for `Tracker.getIssue(id)` — GitHub number, Linear key. */
  issueId: string;
  /** Absolute URL, when derivable from the reference alone. */
  url?: string;
}

/** Why a reference could not be resolved. Each maps to a distinct message. */
export type IssueRefFailure =
  /** The string isn't a recognized reference shape at all. */
  | "unrecognized"
  /** Well-formed, but it identifies no declared destination (req 11). */
  | "undeclared"
  /** Well-formed, but more than one declaration matches (req 11). */
  | "ambiguous"
  /** A name form whose suffix doesn't fit the named backend (`planning#SHI-3`). */
  | "mismatched";

export type IssueRefResolution =
  | { ok: true; ref: ResolvedIssueRef }
  | { ok: false; reason: IssueRefFailure; message: string; identifier: string };

/**
 * The destinations a session can reach: every declaration, plus the session's
 * own GitHub repository under the bare `"github"` id when it has one (req 12's
 * single unnamed exception). Order is declaration order — it drives tab order
 * (req 9) and, here, nothing: matching is by identity, never by position.
 */
export type TrackerDestinations = readonly TrackerDestination[];

/** Case-insensitive equality for backend identity keys (`owner/repo`, team key). */
function keyEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** The declared names available, for a fail-closed error message (req 19). */
export function describeDeclaredNames(destinations: TrackerDestinations): string {
  const names = destinations.map((d) => d.name).filter((n): n is string => Boolean(n));
  if (names.length === 0) {
    return "This repository declares no issue trackers — add an `issues.trackers` entry to shipit.yaml.";
  }
  return `Declared trackers: ${names.join(", ")}.`;
}

/**
 * Look a declared destination up by name (req 12: an operation names its tracker
 * by `name`). Matching is case-insensitive so a reference isn't broken by the
 * casing someone typed; requirement 6 makes `name` unique per repository, and a
 * duplicate that slipped through the parser's own de-duplication still fails
 * closed here rather than picking one.
 */
export function resolveDestinationByName(
  destinations: TrackerDestinations,
  name: string,
): { ok: true; destination: TrackerDestination } | { ok: false; reason: IssueRefFailure; message: string } {
  const needle = name.trim().toLowerCase();
  const matches = destinations.filter((d) => d.name?.toLowerCase() === needle);
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

/**
 * Resolve a reference string against the destinations a session can reach.
 *
 * Accepts all three forms of requirement 10 and applies requirement 11 to each:
 * a name is looked up in the declarations; a canonical address is matched
 * against them by backend identity and, failing that, against the session's own
 * repository. Anything left over fails closed.
 */
export function resolveIssueRef(
  raw: string,
  destinations: TrackerDestinations,
): IssueRefResolution {
  return resolveParsedIssueRef(parseIssueRef(raw), destinations);
}

/**
 * The same resolution, starting from an already-parsed reference. Used where the
 * parse happened earlier for its own reasons — the PR-body scan, which finds the
 * tokens, and the free-text seed scan.
 */
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

  // A canonical address. Match it against the declarations by backend identity —
  // never by the id string alone, so a declaration written with different casing
  // still matches the address a user pasted.
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

  // Not declared — the session's own repository is the one destination that
  // needs no declaration (req 12). It is consulted only after the declarations,
  // so a repository that declares *itself* addresses it by name (and its
  // references render in the name form) rather than through this fallback.
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

/**
 * Whether a canonical tracker id addresses the same destination as `dest`.
 * Compares backend identity rather than the id string so `github:Acme/Planning`
 * and a declaration of `acme/planning` are the same destination, and so the
 * session's own repository (whose id is the bare `"github"`) is matched through
 * its `key`.
 */
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

/**
 * Turn a name form's raw suffix into the named backend's native issue id.
 *
 * GitHub wants a bare number. Linear wants a key, so `roadmap#304` is completed
 * from the declaration's team (`planning#306`) — that completion is the whole reason
 * requirement 5 puts the team key in the declaration.
 *
 * Where the suffix carries a team key of its OWN and it disagrees with the
 * declaration (`roadmap#ABC-3` on team `SHI`), the **name wins** and the suffix's
 * key is discarded (req 16). That is a precedence rule, not a guess: the name
 * already identifies exactly one declared destination, and preferring it is what
 * lets a reference written before a re-point keep resolving.
 *
 * A suffix that doesn't fit the backend at all still fails closed —
 * `planning#SHI-3` on a GitHub tracker names no issue number, so there is nothing
 * to prefer the name *to*.
 */
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
    // req 16 — in a name form the NAME is authoritative and an embedded backend
    // id is advisory. `planning#306` written before `roadmap` was re-pointed
    // to team OPS resolves to `OPS-304` rather than failing on the stale key,
    // which is what lets requirement 15's emitted form survive a re-point.
    //
    // This is the one place ShipIt deliberately resolves past a reference whose
    // two halves disagree — a chosen exception to reqs 11/17, not an oversight.
    // It is safe here because the name still identifies exactly one declared
    // destination: nothing is guessed, one of two stated things is preferred.
    // Reversing a recorded write does NOT come through here (see `undoIssueWrite`),
    // so an undo still acts on the issue its write actually touched.
    issueId = keyed ? `${team}-${keyed[2]}` : `${team}-${suffix}`;
  }

  return {
    ok: true,
    ref: {
      tracker: destination.id,
      trackerName: destination.name ?? name,
      identifier: formatIssueReference({
        trackerName: destination.name ?? name,
        kind: destination.kind,
        key: destination.key,
        issueId,
      }),
      issueId,
    },
  };
}
