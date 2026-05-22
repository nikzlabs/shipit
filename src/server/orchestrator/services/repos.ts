/**
 * Repo services — manages the first-class repo concept.
 * Repos are explicitly added by users and persist across sessions.
 */

import type { RepoStore } from "../repo-store.js";
import type { RepoInfo } from "../../shared/types.js";
import { ServiceError } from "./types.js";

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
  if (!Array.isArray(urls)) {
    throw new ServiceError(400, "urls must be an array");
  }
  // Reject non-string entries before touching the DB — protects against a
  // bad client payload corrupting display_order with non-string url params.
  for (const u of urls) {
    if (typeof u !== "string" || !u.trim()) {
      throw new ServiceError(400, "Each url must be a non-empty string");
    }
  }
  repoStore.setOrder(urls);
  return repoStore.list();
}
