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

export interface EnsureRepoReadyDeps {
  repoStore: {
    get(url: string): { status: string } | undefined;
    add(url: string): unknown;
    setReady(url: string): void;
    list(): { url: string }[];
  };
  getSharedRepoDir: (url: string) => string;
  ensureBareCache: (cacheDir: string, url: string) => Promise<unknown>;
}

/**
 * Register a repository and clone its bare cache, synchronously, so a claim can
 * follow immediately — `claimSession` refuses anything not already `ready`.
 * Used where a session must start on a repository ShipIt may never have seen:
 * Ops fix sessions (docs/162) and cross-repo session proposals (docs/303).
 */
export async function ensureRepoReady(
  url: string,
  deps: EnsureRepoReadyDeps,
): Promise<string> {
  const clean = stripUrlCredentials(url);
  const wanted = canonicalRepoKey(url);
  const existing = deps.repoStore.list().find((r) => canonicalRepoKey(r.url) === wanted);
  // Claims need the existing store key even when an equivalent URL has another spelling.
  const key = existing?.url ?? clean;
  if (deps.repoStore.get(key)?.status === "ready") return key;
  deps.repoStore.add(key);
  await deps.ensureBareCache(deps.getSharedRepoDir(key), key);
  deps.repoStore.setReady(key);
  return key;
}
