import type { CredentialStore } from "../credential-store.js";
import type { TrackerId, TrackerInfo } from "../../shared/types.js";
import type { DeclaredTracker, TrackerDestination } from "../../shared/declared-tracker.js";
import { declaredTrackerLabel, destinationForDeclaration } from "../../shared/declared-tracker.js";
import type { PluginFeedbackRepo } from "../../shared/plugin-feedback.js";
import { pluginFeedbackTrackerId } from "../../shared/plugin-feedback.js";
import { githubTrackerId, parseGitHubTrackerId, parseLinearTrackerId } from "../../shared/tracker-id.js";
import type { Tracker } from "./tracker.js";
import { LinearTracker, type FetchImpl } from "./linear/adapter.js";
import { GitHubTracker, type GitHubRepoRef } from "./github/adapter.js";

export interface GitHubTrackerContext {
  token: string | null;
  repo: GitHubRepoRef | null;
  declared?: DeclaredTracker[];
  warnings?: string[];
  pluginRepos?: readonly PluginFeedbackRepo[];
}

interface RegistryEntry {
  tracker: Tracker;
  listed: boolean;
  destination: TrackerDestination;
}

export class TrackerRegistry {
  private readonly entries: RegistryEntry[];
  private readonly makeRecorded: (id: TrackerId) => Tracker | undefined;

  constructor(entries: RegistryEntry[], makeRecorded: (id: TrackerId) => Tracker | undefined) {
    this.entries = entries;
    this.makeRecorded = makeRecorded;
  }

  list(): TrackerInfo[] {
    return this.entries.filter((e) => e.listed).map((e) => e.tracker.info());
  }

  destinations(): TrackerDestination[] {
    return this.entries.map((e) => e.destination);
  }

  get(id: TrackerId): Tracker | undefined {
    return this.entries.find((e) => e.tracker.id === id)?.tracker;
  }

  // Undo may reach a recorded destination after its declaration is removed.
  getRecorded(id: TrackerId): Tracker | undefined {
    return this.get(id) ?? this.makeRecorded(id);
  }

  destinationFor(id: TrackerId): TrackerDestination | undefined {
    return this.entries.find((e) => e.tracker.id === id)?.destination;
  }

  // Undo uses this to reject names that now point elsewhere, including plugin aliases.
  destinationForName(trackerName: string): TrackerDestination | undefined {
    const needle = trackerName.toLowerCase();
    return this.entries.find(
      (e) =>
        e.destination.name?.toLowerCase() === needle ||
        e.destination.pluginNames?.some((n) => n.toLowerCase() === needle),
    )?.destination;
  }
}

// Rebuild per request: declarations, repository, and credentials can all change.
export function buildTrackerRegistry(
  credentialStore: CredentialStore,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): TrackerRegistry {
  const token = github?.token ?? null;
  const linearToken = credentialStore.getLinearToken();
  const fetchOpt = fetchImpl ? { fetchImpl } : {};

  const makeGitHubTracker = (ref: GitHubRepoRef, name?: string, label?: string): GitHubTracker =>
    new GitHubTracker({
      token,
      repo: ref,
      id: githubTrackerId(ref),
      ...(name ? { name } : {}),
      ...(label ? { label } : {}),
      ...fetchOpt,
    });

  const makeLinearTracker = (teamKey: string, name?: string, label?: string): LinearTracker =>
    new LinearTracker({
      token: linearToken,
      teamKey,
      ...(name ? { name } : {}),
      ...(label ? { label } : {}),
      ...fetchOpt,
    });

  const declared = github?.declared ?? [];
  const sessionRepo = github?.repo ?? null;
  const sameAsSessionRepo = (owner: string, repo: string): boolean =>
    sessionRepo !== null &&
    sessionRepo.owner.toLowerCase() === owner.toLowerCase() &&
    sessionRepo.repo.toLowerCase() === repo.toLowerCase();

  const sessionRepoTracker = new GitHubTracker({ token, repo: sessionRepo, ...fetchOpt });
  const selfDeclared = declared.some((d) => d.kind === "github" && sameAsSessionRepo(d.owner, d.repo));

  const entries: RegistryEntry[] = [
    {
      tracker: sessionRepoTracker,
      // Keep unnamed access without showing a second tab for a self-declared repo.
      listed: !selfDeclared,
      destination: {
        id: "github",
        kind: "github",
        ...(sessionRepo ? { key: `${sessionRepo.owner}/${sessionRepo.repo}` } : {}),
      },
    },
  ];

  for (const decl of declared) {
    const label = declaredTrackerLabel(decl);
    const tracker =
      decl.kind === "github"
        ? makeGitHubTracker({ owner: decl.owner, repo: decl.repo }, decl.name, label)
        : makeLinearTracker(decl.team, decl.name, label);
    entries.push({ tracker, listed: true, destination: destinationForDeclaration(decl) });
  }

  // Alias existing destinations to keep canonical owner/repo references unambiguous.
  for (const plugin of github?.pluginRepos ?? []) {
    const id = pluginFeedbackTrackerId(plugin);
    const existing = entries.find((e) => e.tracker.id.toLowerCase() === id.toLowerCase());
    if (existing) {
      existing.destination.pluginNames = [...(existing.destination.pluginNames ?? []), plugin.name];
      continue;
    }
    entries.push({
      tracker: makeGitHubTracker({ owner: plugin.owner, repo: plugin.repo }, plugin.name, plugin.name),
      listed: false,
      destination: {
        id,
        name: plugin.name,
        key: `${plugin.owner}/${plugin.repo}`,
        kind: "github",
        origin: "plugin",
        pluginNames: [plugin.name],
      },
    });
  }

  return new TrackerRegistry(entries, (id) => {
    const ref = parseGitHubTrackerId(id);
    if (ref) return makeGitHubTracker(ref);
    const team = parseLinearTrackerId(id);
    if (team) return makeLinearTracker(team);
    return undefined;
  });
}
