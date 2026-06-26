/**
 * Repo services — manages the first-class repo concept.
 * Repos are explicitly added by users and persist across sessions.
 */

import type { RepoStore } from "../repo-store.js";
import type { RepoInfo } from "../../shared/types.js";
import { canonicalRepoKey } from "../git-utils.js";
import { ServiceError } from "./types.js";
import { validateStringArray } from "./validation.js";

/** List all repos. */
export function listRepos(repoStore: RepoStore): RepoInfo[] {
  return repoStore.list();
}

/** Add a repo. Returns the new or existing RepoInfo. */
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
