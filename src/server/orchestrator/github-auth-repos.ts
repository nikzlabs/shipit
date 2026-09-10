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
