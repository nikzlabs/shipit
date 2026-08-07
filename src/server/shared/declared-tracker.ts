/**
 * Declared issue trackers (docs/248 reqs 1–6) — the types and the small amount
 * of pure logic that turns a declaration into a routable destination.
 *
 * Deliberately **filesystem-free** so both halves of the app can import it. The
 * parser that produces these lives in `shipit-config.ts` (which reads
 * `shipit.yaml` and therefore pulls in `node:fs`); the resolver
 * (`issue-ref-resolution.ts`) and the browser both need the *shape* without that
 * dependency. `shipit-config.ts` re-exports these types so existing importers
 * keep working.
 *
 * A declaration is a **tagged union on `kind`** — the same discriminator the
 * issue domain types already use for `IssueWriteUndo`. `kind` selects the
 * backend; the remaining fields are whatever that backend needs to identify
 * itself (`repo` for GitHub, `team` for Linear); `name` is how everything else
 * addresses it (req 2). A backend identified by something other than a
 * repository therefore needs no reshaping of the block.
 */

import type { TrackerId } from "./types/domain-types/issue.js";
import { githubTrackerId, linearTrackerId } from "./tracker-id.js";

/** A GitHub Issues tracker, identified by its repository. */
export interface DeclaredGitHubTracker {
  kind: "github";
  /** How every reference and operation addresses this tracker (req 2). */
  name: string;
  /** Optional Issues-tab label (req 9a); defaults to `name`. */
  label?: string;
  owner: string;
  repo: string;
}

/**
 * A Linear tracker, identified by its team key (req 5). Linear binds a tracker
 * to one team, and the key is also the prefix its issue keys carry — which is
 * what lets a bare `SHI-304` resolve to this declaration. The *workspace* comes
 * from the credential, not the declaration (req 23), so no workspace field
 * exists here.
 */
export interface DeclaredLinearTracker {
  kind: "linear";
  /** How every reference and operation addresses this tracker (req 2). */
  name: string;
  /** Optional Issues-tab label (req 9a); defaults to `name`. */
  label?: string;
  /** Linear team key, normalized to upper case (e.g. `SHI`). */
  team: string;
}

/** docs/248 — one entry of `issues.trackers`. */
export type DeclaredTracker = DeclaredGitHubTracker | DeclaredLinearTracker;

/** The `kind` values this build recognizes. An unknown one warns and skips (req 7). */
export const KNOWN_TRACKER_KINDS: readonly DeclaredTracker["kind"][] = ["github", "linear"];

/** The tracker id a declaration resolves to — its routable destination. */
export function declaredTrackerId(decl: DeclaredTracker): TrackerId {
  return decl.kind === "github"
    ? githubTrackerId({ owner: decl.owner, repo: decl.repo })
    : linearTrackerId(decl.team);
}

/**
 * What the Issues tab shows for a declaration (req 9a): the declared `label`
 * when there is one, else the `name`.
 *
 * The two are deliberately separate fields. `name` is an *address* — it has to be
 * writable as `planning#42`, so it is constrained to a reference-safe character
 * set and is usually a terse lower-case slug. A tab label has no such constraint
 * and wants to read as a human heading ("Planning"). While the field was missing
 * the tab rendered `name · <backend key>`, which spent its width on a
 * `nikzlabs/shipit-planning` slug the reader already knows.
 *
 * `label` is the field's original spelling: it shipped in v0.3.1 (`5fbd3047`)
 * and the rework that introduced `name` (`06f5f757`) dropped it without a
 * requirement asking for the removal. Restoring the same name — rather than
 * coining a new one — is what keeps a `shipit.yaml` written in that window valid
 * with no alias to carry. It does read close to an *issue* label (`--label`,
 * `IssueLabel`), so a tracker's is always this one function's business, never a
 * bare `label` variable at a call site.
 */
export function declaredTrackerLabel(decl: DeclaredTracker): string {
  return decl.label ?? decl.name;
}

/**
 * The backend's own identity string for a declaration — a GitHub `owner/repo`,
 * a Linear team key. Carried on {@link TrackerDestination} so a canonical
 * address can be matched against a destination without re-parsing its id.
 */
export function declaredTrackerKey(decl: DeclaredTracker): string {
  return decl.kind === "github" ? `${decl.owner}/${decl.repo}` : decl.team;
}

/**
 * A destination a reference may resolve to (docs/248 req 11). This is the whole
 * resolution context: the set of destinations reachable from a session, each
 * with the `name` it was declared under (absent for the session's own
 * repository, the one destination that needs no declaration — req 12).
 *
 * Deliberately *not* `DeclaredTracker`: the session's own repository is a
 * reachable destination without being a declaration, and the browser builds this
 * from the `TrackerInfo[]` it already fetched for the tab list rather than from
 * `shipit.yaml`, which it never sees.
 */
export interface TrackerDestination {
  id: TrackerId;
  /** The declared `name`, when this destination was declared. */
  name?: string;
  /** The backend's own identity: GitHub `owner/repo`, Linear team key. */
  key?: string;
  kind: DeclaredTracker["kind"];
}

/** Build a {@link TrackerDestination} from a declaration. */
export function destinationForDeclaration(decl: DeclaredTracker): TrackerDestination {
  return {
    id: declaredTrackerId(decl),
    name: decl.name,
    key: declaredTrackerKey(decl),
    kind: decl.kind,
  };
}
