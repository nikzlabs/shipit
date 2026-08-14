/**
 * Repo services — manages the first-class repo concept.
 * Repos are explicitly added by users and persist across sessions.
 */

import type { RepoStore } from "../repo-store.js";
import type { RepoInfo } from "../../shared/types.js";
import { canonicalRepoKey, hasUrlCredentials, stripUrlCredentials } from "../git-utils.js";
import { REPO_COLOR_COUNT, isValidRepoColorIndex } from "../../shared/repo-colors.js";
import { ServiceError } from "./types.js";
import { validateStringArray } from "./validation.js";

/** List all repos. */
export function listRepos(repoStore: RepoStore): RepoInfo[] {
  return repoStore.list();
}

/**
 * Add a repo. Returns the new or existing RepoInfo.
 *
 * A credential the user types into the URL is **dropped, not stored**
 * (docs/262 req 19). ShipIt authenticates a fetch through a credential helper
 * scoped to that remote, for the life of the fetch, and keeps it out of every
 * file — so a URL like `https://x-access-token:<pat>@github.com/o/r.git` would
 * otherwise end up in the repo row, in the bare cache's config, and from there
 * in every session clone's `/project/.git/config`, which the agent and every
 * plugin CLI and plugin service can read.
 *
 * Known, accepted cost, recorded with the requirement: a remote whose ONLY
 * working auth is that embedded credential stops working on the helper path —
 * it degrades to an anonymous fetch, and no fallback keeps the credential
 * (that fallback is what req 19 forbids). The `console.warn` is
 * what makes the resulting failure legible rather than an unexplained "could
 * not read Username" — the clone runs anonymously, and the caller surfaces the
 * clone error the same way it always has (req 13).
 */
export function addRepo(
  repoStore: RepoStore,
  url: string,
): RepoInfo {
  if (!url?.trim()) {
    throw new ServiceError(400, "Repository URL is required");
  }

  let normalized = url.trim();

  // Support owner/repo shorthand
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(normalized)) {
    normalized = `https://github.com/${normalized}.git`;
  }

  if (hasUrlCredentials(normalized)) {
    normalized = stripUrlCredentials(normalized);
    console.warn(
      `[repos] Dropped the credential embedded in the URL for ${normalized} — ShipIt never stores one. `
      + "Access is supplied by the GitHub connection (PAT or App installation) at fetch time; "
      + "if that connection cannot reach this repository, adding it will fail to clone.",
    );
  }

  return repoStore.add(normalized);
}

/**
 * docs/178 — grant trust to a remote (trust-on-first-use). Trusting a remote
 * unblocks all repo-declared auto-execution (agent.install + compose
 * command:/build:) for it, now and for every future session cloned from it.
 * Matched by canonical key so the decision is per-remote regardless of URL
 * form. Throws 404 when the remote isn't a tracked repo.
 */
export function setRepoTrusted(
  repoStore: RepoStore,
  url: string | undefined,
): void {
  if (!url?.trim()) {
    throw new ServiceError(400, "Repository URL is required");
  }
  const trimmed = url.trim();
  const key = canonicalRepoKey(trimmed);
  const known = repoStore.list().some((r) => canonicalRepoKey(r.url) === key);
  if (!known) {
    throw new ServiceError(404, "Repository not found");
  }
  repoStore.setTrusted(trimmed, true);
}

/**
 * docs/222 — hide or show a repo in the sidebar. A pure visibility flag: it does
 * NOT touch sessions, containers, working copies, or history (unlike removeRepo).
 * Throws 404 when the url isn't a tracked repo.
 */
export function setRepoHidden(
  repoStore: RepoStore,
  url: string | undefined,
  hidden: boolean,
): void {
  if (!url?.trim()) {
    throw new ServiceError(400, "Repository URL is required");
  }
  const updated = repoStore.setHidden(url.trim(), hidden);
  if (!updated) {
    throw new ServiceError(404, "Repository not found");
  }
}

/**
 * docs/254 — reject anything that isn't a usable palette index. Exported so the
 * route can validate the whole body BEFORE writing any of it: a PATCH carrying
 * both `hidden` and a bad `colorIndex` must leave the row untouched rather than
 * commit the first update and throw on the second.
 */
export function assertValidRepoColorIndex(colorIndex: unknown): asserts colorIndex is number {
  if (!isValidRepoColorIndex(colorIndex)) {
    throw new ServiceError(400, `colorIndex must be an integer between 0 and ${REPO_COLOR_COUNT - 1}`);
  }
}

/**
 * docs/254 — set a repo's identity color, the palette index behind the sidebar's
 * per-repo group edge. Validated against the palette rather than stored blind,
 * so a bad client can't write an index that renders as `var(--repo-color-99)`
 * and silently produces no color at all. Throws 404 when the url isn't tracked.
 */
export function setRepoColorIndex(
  repoStore: RepoStore,
  url: string | undefined,
  colorIndex: unknown,
): void {
  if (!url?.trim()) {
    throw new ServiceError(400, "Repository URL is required");
  }
  assertValidRepoColorIndex(colorIndex);
  const updated = repoStore.setColorIndex(url.trim(), colorIndex);
  if (!updated) {
    throw new ServiceError(404, "Repository not found");
  }
}

/** Remove a repo from the store. */
export function removeRepo(
  repoStore: RepoStore,
  url: string,
): boolean {
  if (!url?.trim()) {
    throw new ServiceError(400, "Repository URL is required");
  }
  const removed = repoStore.remove(url.trim());
  if (!removed) {
    throw new ServiceError(404, "Repository not found");
  }
  return true;
}

/**
 * Reorder repos in the sidebar. The `urls` list is the new top-down order.
 * The list may be a subset of the known repos — unknown urls are ignored
 * (the client could be slightly out-of-date after a concurrent remove).
 * Returns the updated repo list in the new order.
 */
export function reorderRepos(
  repoStore: RepoStore,
  urls: string[],
): RepoInfo[] {
  // Reject non-string/empty entries before touching the DB — protects against
  // a bad client payload corrupting display_order with non-string url params.
  const list = validateStringArray(urls, "urls");
  if (list.some((u) => !u.trim())) {
    throw new ServiceError(400, "Each url must be a non-empty string");
  }
  repoStore.setOrder(urls);
  return repoStore.list();
}
