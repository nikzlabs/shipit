import type { TrackerId } from "./types/domain-types/issue.js";
import { githubTrackerId, linearTrackerId } from "./tracker-id.js";

export interface DeclaredGitHubTracker {
  kind: "github";
  name: string;
  label?: string;
  owner: string;
  repo: string;
}

export interface DeclaredLinearTracker {
  kind: "linear";
  name: string;
  label?: string;
  /** Uppercase team key; the credential supplies the workspace. */
  team: string;
}

export type DeclaredTracker = DeclaredGitHubTracker | DeclaredLinearTracker;

export function declaredTrackerId(decl: DeclaredTracker): TrackerId {
  return decl.kind === "github"
    ? githubTrackerId({ owner: decl.owner, repo: decl.repo })
    : linearTrackerId(decl.team);
}

export function declaredTrackerLabel(decl: DeclaredTracker): string {
  return decl.label ?? decl.name;
}

export function declaredTrackerKey(decl: DeclaredTracker): string {
  return decl.kind === "github" ? `${decl.owner}/${decl.repo}` : decl.team;
}

export interface TrackerDestination {
  id: TrackerId;
  name?: string;
  /** GitHub owner/repo or Linear team key. */
  key?: string;
  kind: DeclaredTracker["kind"];
  /** Feedback destination only; no Issues tab. */
  origin?: "plugin";
  /** Aliases share a destination to keep canonical references unambiguous. */
  pluginNames?: string[];
}

export function isPluginFeedbackDestination(dest: TrackerDestination): boolean {
  return dest.origin === "plugin";
}

export function destinationForDeclaration(decl: DeclaredTracker): TrackerDestination {
  return {
    id: declaredTrackerId(decl),
    name: decl.name,
    key: declaredTrackerKey(decl),
    kind: decl.kind,
  };
}
