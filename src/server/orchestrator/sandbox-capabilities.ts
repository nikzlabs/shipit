import type { SessionCapabilities, SessionSettingsChangeEntry } from "../shared/types.js";

// Snapshot labels into cards so later renames cannot alter recorded decisions.
export const CAPABILITY_LABELS: Record<keyof SessionCapabilities, string> = {
  git: "GitHub access",
  dangerousGitHubOps: "Allow merging PRs",
  docker: "Docker access",
  network: "Network access",
};

export const CAPABILITY_ORDER: (keyof SessionCapabilities)[] = [
  "git",
  "dangerousGitHubOps",
  "docker",
  "network",
];

export function capabilitiesPendingRestart(
  started: SessionCapabilities | null | undefined,
  current: SessionCapabilities,
): boolean {
  if (!started) return false;
  if (started.docker !== current.docker) return true;
  if (started.network !== current.network) return true;
  // With Network off, the git grant changes the container's lifeline allowlist.
  if (!current.network && started.git !== current.git) return true;
  return false;
}

export function describeCapabilityChanges(
  previous: SessionCapabilities,
  next: SessionCapabilities,
): SessionSettingsChangeEntry[] {
  return CAPABILITY_ORDER
    .filter((key) => previous[key] !== next[key])
    .map((key) => ({
      label: CAPABILITY_LABELS[key],
      from: previous[key] ? "on" : "off",
      to: next[key] ? "on" : "off",
      granted: next[key],
    }));
}
