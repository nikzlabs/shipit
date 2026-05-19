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
  options: { description?: string; isPrivate?: boolean } = {},
): Promise<GitHubRepoResult> {
  try {
    const res = await fetchGitHub("https://api.github.com/user/repos", token, {
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
