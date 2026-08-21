/**
 * docs/262 req 25 — feedback on a plugin, filed as an issue on the **plugin's
 * own repository** from inside a project session.
 *
 * The whole channel is one sentence: *a declared plugin repository is a
 * reachable issue destination*. There is no second issue path beside
 * `shipit issue` — the same registry, the same adapters, the same brokering, so
 * the tracker credential still never enters the session container (docs/248).
 * What this module owns is the small amount of pure logic that turns a
 * `plugins.repos` entry into that destination and stamps the session's context
 * onto a report.
 *
 * Filesystem-free, like `plugin-repos.ts` and `declared-tracker.ts`: the
 * orchestrator reads the live generation off disk and hands the result in.
 *
 * **This does not relax req 7.** A destination is an issue-API address; nothing
 * here (and nothing it feeds) touches a git remote, a branch or a push. The
 * plugin checkout stays read-only, and filing an issue is the whole channel.
 */

import { githubTrackerId } from "./tracker-id.js";
import type { TrackerId } from "./types/domain-types/issue.js";
import type { PluginReposConfig } from "./plugin-repos.js";
import type { TrackerDestination } from "./declared-tracker.js";
import { isPluginFeedbackDestination } from "./declared-tracker.js";

/**
 * A declared plugin repository as a feedback destination, plus what the session
 * is actually running from it (req 15). `ref`/`commit` are absent until a
 * generation is active — a report filed before then still files, and says so.
 */
export interface PluginFeedbackRepo {
  /** The declared `plugins.repos[].name` — how a report addresses it. */
  name: string;
  owner: string;
  repo: string;
  /** What the consumer declared: `branch main`, `pin v1.2.0`. */
  ref?: string;
  /** The exact commit the session is running from this repository (req 15). */
  commit?: string;
}

/**
 * The feedback destinations a consumer declaration produces.
 *
 * **`repo: self` produces none** (plan §1a): its issues are already this
 * session's own repository, which every session reaches without a declaration
 * (docs/248-declared-issue-trackers req 12). Minting a second name for it would put one repository's
 * issues behind two addresses for no gain.
 *
 * The `use:` block is deliberately not consulted: one destination per declared
 * *repository*, however many plugins are used from it — feedback is about the
 * repository that would have to fix it, and `plugins.repos[].name` is the name
 * already reserved across the tracker namespace (plan §1a phase 1).
 */
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

/**
 * Whether an operation addressed this destination **as a plugin repository**.
 *
 * The name is the signal, not the destination, and the two differ in exactly
 * one case: a repository declared BOTH as a tracker and as a plugin repository
 * is one destination carrying two names (see `TrackerDestination.pluginNames`),
 * and which name the operation used is the whole statement of intent.
 * `--tracker tools` is feedback on the plugin; `--tracker planning` is an
 * ordinary issue on the project's own tracker. Deciding from the destination
 * alone collapses those two, which silently drops the running-commit context
 * from req 25's own case (review finding).
 *
 * With no name — an operation addressed by raw tracker id — the destination's
 * origin is the only signal there is.
 */
export function addressedAsPluginRepo(
  destination: TrackerDestination | undefined,
  addressedAs: string | undefined,
): boolean {
  if (!destination) return false;
  const needle = addressedAs?.trim().toLowerCase();
  if (!needle) return isPluginFeedbackDestination(destination);
  return (destination.pluginNames ?? []).some((n) => n.toLowerCase() === needle);
}

/** The tracker id a plugin feedback destination routes to. */
export function pluginFeedbackTrackerId(repo: PluginFeedbackRepo): TrackerId {
  return githubTrackerId({ owner: repo.owner, repo: repo.repo });
}

/**
 * The session context a report carries (req 25): which plugin repository this
 * is feedback on, and **the exact commit the session was running** — the
 * version-observability of req 15, on the report rather than only on the card.
 *
 * ShipIt stamps it rather than asking the agent to remember, because the agent
 * has no other way to know the commit: the checkout it browses is a staged
 * export, not a clone with a `HEAD`. The repro and the proposed diff stay the
 * author's — they are the body, and this is a footer under it.
 */
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

/** The report body with its context footer appended (req 25). */
export function withPluginFeedbackContext(body: string, repo: PluginFeedbackRepo): string {
  const trimmed = body.trimEnd();
  const footer = pluginFeedbackFooter(repo);
  return trimmed ? `${trimmed}\n\n${footer}\n` : `${footer}\n`;
}
