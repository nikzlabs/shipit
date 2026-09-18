import { githubTrackerId } from "./tracker-id.js";
import type { TrackerId } from "./types/domain-types/issue.js";
import type { PluginReposConfig } from "./plugin-repos.js";
import type { TrackerDestination } from "./declared-tracker.js";
import { isPluginFeedbackDestination } from "./declared-tracker.js";

export interface PluginFeedbackRepo {
  name: string;
  owner: string;
  repo: string;
  ref?: string;
  commit?: string;
}

export function pluginFeedbackRepos(plugins: PluginReposConfig): PluginFeedbackRepo[] {
  return plugins.repos
    .filter((r) => r.source.kind === "github")
    .map((r) => {
      const source = r.source as { kind: "github"; owner: string; repo: string };
      return {
        name: r.name,
        owner: source.owner,
        repo: source.repo,
        ref: r.pin ? `pin ${r.pin}` : r.branch ? `branch ${r.branch}` : "default branch",
      };
    });
}

/** The addressed alias distinguishes plugin feedback from tracker use of the same repo. */
export function addressedAsPluginRepo(
  destination: TrackerDestination | undefined,
  addressedAs: string | undefined,
): boolean {
  if (!destination) return false;
  const needle = addressedAs?.trim().toLowerCase();
  if (!needle) return isPluginFeedbackDestination(destination);
  return (destination.pluginNames ?? []).some((n) => n.toLowerCase() === needle);
}

export function pluginFeedbackTrackerId(repo: PluginFeedbackRepo): TrackerId {
  return githubTrackerId({ owner: repo.owner, repo: repo.repo });
}

export function pluginFeedbackFooter(repo: PluginFeedbackRepo): string {
  const version = repo.commit
    ? `${repo.ref ? `${repo.ref} @ ` : ""}\`${repo.commit}\``
    : `${repo.ref ?? "declared version"} — no plugin generation is active in this session yet`;
  return [
    "---",
    `Filed from a ShipIt project session using this repository as the plugin repository \`${repo.name}\`.`,
    `Version in use: ${version}`,
  ].join("\n");
}

export function withPluginFeedbackContext(body: string, repo: PluginFeedbackRepo): string {
  const trimmed = body.trimEnd();
  const footer = pluginFeedbackFooter(repo);
  return trimmed ? `${trimmed}\n\n${footer}\n` : `${footer}\n`;
}
