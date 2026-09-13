import type { GitHubRepoResult } from "./github-auth.js";
import { getErrorMessage } from "../shared/utils.js";
import { fetchGitHub, parseGitHubError } from "./github-api.js";

export async function createRepo(
  token: string,
  name: string,
  options: { description?: string; isPrivate?: boolean; owner?: string } = {},
): Promise<GitHubRepoResult> {
  try {
    // Omit owner for a personal repo; a supplied owner selects an organization.
    const endpoint = options.owner
      ? `https://api.github.com/orgs/${encodeURIComponent(options.owner)}/repos`
      : "https://api.github.com/user/repos";
    const res = await fetchGitHub(endpoint, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: options.description || "",
        private: options.isPrivate ?? true,
        auto_init: false,
      }),
    });

    if (!res.ok) {
      return {
        success: false,
        message: await parseGitHubError(res),
      };
    }

    const data = (await res.json()) as {
      name: string;
      full_name: string;
      html_url: string;
      clone_url: string;
    };
    return {
      success: true,
      name: data.name,
      fullName: data.full_name,
      url: data.html_url,
      cloneUrl: data.clone_url,
    };
  } catch (err) {
    return {
      success: false,
      message: getErrorMessage(err),
    };
  }
}

export interface GitHubRepoSummary {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

/** Only the two fields every consumer indexes on are required; the rest get defaults. */
interface GitHubRepoPayload {
  full_name: string;
  clone_url: string;
  description?: string | null;
  private?: boolean;
  default_branch?: string;
}

const USER_REPOS_PER_PAGE = 100;
/** Bounds the walk so an account with thousands of repos can't stall a repo search. */
const USER_REPOS_MAX_PAGES = 10;

export interface UserRepoListing {
  repos: GitHubRepoSummary[];
  /**
   * A page request failed, so entries a retry might return are missing. Distinct
   * from stopping at `USER_REPOS_MAX_PAGES`, which truncates deterministically
   * and is safe to cache.
   */
  failed: boolean;
}

function isRepoPayload(value: unknown): value is GitHubRepoPayload {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<GitHubRepoPayload>;
  return typeof r.full_name === "string" && typeof r.clone_url === "string";
}

/** Drops entries missing the fields every consumer indexes on, rather than ranking `undefined`. */
function toRepoSummaries(data: unknown[]): GitHubRepoSummary[] {
  return data.filter(isRepoPayload).map((r) => ({
    fullName: r.full_name,
    description: r.description ?? null,
    private: r.private ?? false,
    defaultBranch: r.default_branch ?? "main",
    cloneUrl: r.clone_url,
  }));
}

/**
 * Every repo the account owns or collaborates on, most recently pushed first.
 * Paginated in full because repo search ranks these ahead of GitHub's own
 * search results (docs/027-github-import), which drop personal repos.
 */
export async function listUserRepos(token: string): Promise<UserRepoListing> {
  const repos: GitHubRepoSummary[] = [];
  try {
    for (let page = 1; page <= USER_REPOS_MAX_PAGES; page++) {
      const res = await fetchGitHub(
        `https://api.github.com/user/repos?sort=pushed&per_page=${USER_REPOS_PER_PAGE}&page=${page}&affiliation=owner,collaborator`,
        token,
      );
      if (!res.ok) return { repos, failed: true };

      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) return { repos, failed: true };
      repos.push(...toRepoSummaries(data));
      if (data.length < USER_REPOS_PER_PAGE) break;
    }
  } catch {
    // Network failure mid-walk: keep the pages that already arrived, but say so.
    return { repos, failed: true };
  }
  return { repos, failed: false };
}

export async function listOrgs(token: string): Promise<{ login: string; avatarUrl: string }[]> {
  try {
    const res = await fetchGitHub("https://api.github.com/user/orgs?per_page=100", token);
    if (!res.ok) return [];
    const data = (await res.json()) as { login: string; avatar_url: string }[];
    return data.map((o) => ({ login: o.login, avatarUrl: o.avatar_url }));
  } catch {
    return [];
  }
}

export async function checkRepoWriteAccess(
  token: string,
  owner: string,
  repo: string,
): Promise<{ canWrite: boolean; reason?: string }> {
  try {
    const res = await fetchGitHub(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      token,
    );
    if (res.status === 404) {
      return { canWrite: false, reason: `Repository ${owner}/${repo} is not visible to this account.` };
    }
    if (!res.ok) {
      return { canWrite: false, reason: await parseGitHubError(res) };
    }
    const data = (await res.json()) as {
      permissions?: { push?: boolean; maintain?: boolean; admin?: boolean };
    };
    const perms = data.permissions ?? {};
    const canWrite = Boolean(perms.push || perms.maintain || perms.admin);
    return canWrite
      ? { canWrite: true }
      : { canWrite: false, reason: `The authenticated account has read-only access to ${owner}/${repo}.` };
  } catch (err) {
    return { canWrite: false, reason: getErrorMessage(err) };
  }
}

export async function searchRepos(token: string, query: string): Promise<GitHubRepoSummary[]> {
  try {
    const res = await fetchGitHub(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+in:name&sort=updated&per_page=10`,
      token,
    );

    if (!res.ok) return [];

    const data = (await res.json()) as { items?: unknown };
    // Degrade to the personal-repo half of the search rather than failing it.
    if (!Array.isArray(data.items)) return [];
    return toRepoSummaries(data.items);
  } catch {
    return [];
  }
}
