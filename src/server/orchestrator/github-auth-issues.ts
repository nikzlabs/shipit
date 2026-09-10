import { getErrorMessage } from "../shared/utils.js";
import { fetchGitHub, parseGitHubError } from "./github-api.js";

export interface CreateIssueResult {
  success: boolean;
  url?: string;
  number?: number;
  message?: string;
  scopeError?: boolean;
}

// GitHub can discard labels when the filer lacks push access.
export async function createIssue(
  token: string,
  options: { owner: string; repo: string; title: string; body: string; labels?: string[] },
): Promise<CreateIssueResult> {
  try {
    const res = await fetchGitHub(
      `https://api.github.com/repos/${options.owner}/${options.repo}/issues`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: options.title,
          body: options.body,
          ...(options.labels && options.labels.length > 0 ? { labels: options.labels } : {}),
        }),
      },
    );

    if (!res.ok) {
      const message = await parseGitHubError(res);
      if (res.status === 403 || res.status === 404) {
        // A 404 can also mean the token cannot see the repo.
        return {
          success: false,
          scopeError: true,
          message:
            "Your GitHub token can't file issues on the ShipIt repo. Reconnect GitHub in Settings with a token that has public_repo (classic) or Issues access (fine-grained).",
        };
      }
      return { success: false, message };
    }

    const data = (await res.json()) as { html_url: string; number: number };
    return { success: true, url: data.html_url, number: data.number };
  } catch (err) {
    return { success: false, message: getErrorMessage(err) };
  }
}
