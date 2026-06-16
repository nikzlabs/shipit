/**
 * GitHub repository operations — extracted from GitHubAuthManager.
 * Functions in this module handle repo creation, listing, and search.
 */

import type { GitHubRepoResult } from "./github-auth.js";
import { getErrorMessage } from "../shared/utils.js";
import { fetchGitHub, parseGitHubError } from "./github-api.js";

/**
 * Create a new GitHub repository via the API.
 * Returns repo details on success, error message on failure.
 */
export async function createRepo(
  token: string,
  name: string,
  options: { description?: string; isPrivate?: boolean; owner?: string } = {},
): Promise<GitHubRepoResult> {
  try {
    // `owner` selects an organization: POST /orgs/{org}/repos creates the repo
    // inside that org, whereas the bare POST /user/repos endpoint creates it
    // under the authenticated user's personal account. Callers omit `owner`
    // (or pass the personal login) for a personal repo. If the user lacks
    // repo-creation rights in the org, GitHub answers 403 and the message is
    // surfaced verbatim via parseGitHubError below.
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

/**
 * List the authenticated user's repos, sorted by most recently pushed.
 * Used to populate the repo selector before the user types a search query.
 */
export async function listUserRepos(token: string): Promise<{
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}[]> {
  try {
    const res = await fetchGitHub(
      "https://api.github.com/user/repos?sort=pushed&per_page=15&affiliation=owner,collaborator",
      token,
    );

    if (!res.ok) return [];

    const data = (await res.json()) as { full_name: string; description: string | null; private: boolean; default_branch: string; clone_url: string }[];
    return data.map((r) => ({
      fullName: r.full_name,
      description: r.description,
      private: r.private,
      defaultBranch: r.default_branch,
      cloneUrl: r.clone_url,
    }));
  } catch {
    return [];
  }
}

/**
 * List the organizations the authenticated user belongs to, for the new-repo
 * owner picker. Returns every membership — including orgs where the user may
 * lack repo-creation rights; the create call surfaces GitHub's 403 if so.
 * Never throws (returns `[]` on error) so the dialog degrades to personal-only.
 */
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

/**
 * docs/162 — check whether the authenticated user can push to `owner/repo`.
 *
 * Uses `GET /repos/{owner}/{repo}`, whose `permissions` block reflects the
 * *authenticated* user's effective access (push / maintain / admin all imply
 * write). Returns `{ canWrite, reason }` — never throws, so the Ops fix-session
 * spawn can degrade to a structured incident report instead of erroring.
 */
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

/**
 * Search the user's accessible repos by name.
 */
export async function searchRepos(token: string, query: string): Promise<{
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}[]> {
  const res = await fetchGitHub(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+in:name&sort=updated&per_page=10`,
    token,
  );

  if (!res.ok) return [];

  const data = (await res.json()) as { items: { full_name: string; description: string | null; private: boolean; default_branch: string; clone_url: string }[] };
  return data.items.map((r) => ({
    fullName: r.full_name,
    description: r.description,
    private: r.private,
    defaultBranch: r.default_branch,
    cloneUrl: r.clone_url,
  }));
}
