import type { RepoStore } from "../repo-store.js";
import type { RepoInfo } from "../../shared/types.js";
import { canonicalRepoKey, hasUrlCredentials, stripUrlCredentials } from "../git-utils.js";
import { REPO_COLOR_COUNT, isValidRepoColorIndex } from "../../shared/repo-colors.js";
import { ServiceError } from "./types.js";
import { validateStringArray } from "./validation.js";

export function listRepos(repoStore: RepoStore): RepoInfo[] {
  return repoStore.list();
}

export function addRepo(
  repoStore: RepoStore,
  url: string,
): RepoInfo {
  if (!url?.trim()) {
    throw new ServiceError(400, "Repository URL is required");
  }

  let normalized = url.trim();

  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(normalized)) {
    normalized = `https://github.com/${normalized}.git`;
  }

  // Stored URLs reach clone configs; never retain embedded credentials.
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

// Routes validate combined updates before writing any field.
export function assertValidRepoColorIndex(colorIndex: unknown): asserts colorIndex is number {
  if (!isValidRepoColorIndex(colorIndex)) {
    throw new ServiceError(400, `colorIndex must be an integer between 0 and ${REPO_COLOR_COUNT - 1}`);
  }
}

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

export function reorderRepos(
  repoStore: RepoStore,
  urls: string[],
): RepoInfo[] {
  const list = validateStringArray(urls, "urls");
  if (list.some((u) => !u.trim())) {
    throw new ServiceError(400, "Each url must be a non-empty string");
  }
  repoStore.setOrder(urls);
  return repoStore.list();
}
