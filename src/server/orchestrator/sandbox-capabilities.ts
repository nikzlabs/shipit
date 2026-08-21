/**
 * docs/279-mutable-sandbox-capabilities — the two questions every surface asks
 * about a sandbox session's grants once they are editable:
 *
 *   1. **Does applying this change need a container restart?**
 *   2. **What changed, in the words the user chose it by?**
 *
 * Both live here so the edit route, the transcript card and (via the view type)
 * the dialog cannot answer them differently. This is the same reason
 * `egress-host-reach.ts` exists for its one question: three surfaces each
 * re-deriving a predicate is how they end up disagreeing about the same session.
 */

import type { SessionCapabilities, SessionSettingsChangeEntry } from "../shared/types.js";

/**
 * The user-facing name of each grant — the labels the creation dialog and the
 * settings dialog both render, and the ones a transcript card records.
 *
 * Snapshotted INTO the card rather than looked up when it renders: a card is a
 * record of what the user did, so renaming a capability later must not rewrite
 * what an old row says happened.
 */
export const CAPABILITY_LABELS: Record<keyof SessionCapabilities, string> = {
  git: "GitHub access",
  dangerousGitHubOps: "Allow merging PRs",
  docker: "Docker access",
  network: "Network access",
};

/** Stable render/report order — the order the capability dialog lists them in. */
export const CAPABILITY_ORDER: (keyof SessionCapabilities)[] = [
  "git",
  "dangerousGitHubOps",
  "docker",
  "network",
];

/**
 * Whether the durable grants and the ones the LIVE container was created with
 * disagree in a way only a restart can settle.
 *
 * Which capability lands live and which pends is not a policy choice — it
 * follows from where each grant is READ:
 *
 *  - `git` and `dangerousGitHubOps` are checked orchestrator-side, per request,
 *    by `gitCredentialAllowed` / `prMergeAllowed` (`pr-target.ts`). The durable
 *    write IS the application; there is nothing in the container to re-plumb.
 *  - `docker` becomes `DOCKER_HOST` plus a session bridge network, resolved by
 *    `buildConfigForWorkspace({ dockerAccess })` at container creation.
 *  - `network` selects the whole egress topology (`sandboxLifelineEgressConfig`),
 *    installed into the container's netns by the Tier A/B/C sidecars at creation.
 *
 * The last clause is the non-obvious one. A network-OFF sandbox's lifeline
 * allowlist contains `github.com` only when `git` is granted
 * (`sandboxLifelineBase`), so flipping `git` there changes the container's egress
 * plumbing even though `git` is otherwise live. Folding it in here — rather than
 * driving a live `reloadEgress` — keeps this predicate purely derived and adds no
 * new failure path: a reload REMOVES the resolver and proxy before launching
 * replacements and throws if that launch fails, which would leave the agent with
 * no DNS in exchange for saving a restart the user can already click.
 *
 * `started` is `null` when it is not knowable — no running container, or one the
 * orchestrator only rediscovered after a restart. Unknown reports NO pending
 * diff, the same convention `egressContainedAtStart` uses: a false "pending"
 * that no restart can clear is worse than staying quiet.
 */
export function capabilitiesPendingRestart(
  started: SessionCapabilities | null | undefined,
  current: SessionCapabilities,
): boolean {
  if (!started) return false;
  if (started.docker !== current.docker) return true;
  if (started.network !== current.network) return true;
  if (!current.network && started.git !== current.git) return true;
  return false;
}

/**
 * The grants that actually MOVED, labelled and in dialog order — the payload of
 * the transcript card. Empty when nothing changed, which is what keeps a save
 * that selects the current state from writing a row claiming something happened.
 */
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
