/**
 * GitHub issue operations — extracted from GitHubAuthManager (docs/164).
 *
 * Used by the user-bug-filing flow to open an issue on the upstream ShipIt
 * repo under the *user's own* GitHub identity (the same token used for PRs).
 * This is a server-side REST call, NOT the `gh issue` shim (which is
 * intentionally blocked).
 */

import { getErrorMessage } from "../shared/utils.js";
import { fetchGitHub, parseGitHubError } from "./github-api.js";

export interface CreateIssueResult {
  success: boolean;
  url?: string;
  number?: number;
  message?: string;
  /**
   * True when GitHub rejected the create for lack of permission/scope on the
   * target repo (403). The common case is a fine-grained PAT scoped only to
   * the user's own repos: it has no Issues:write on the upstream repo. The
   * caller surfaces this as a "reconnect with a token that can file issues"
   * prompt rather than a generic failure. We do NOT pre-flight a scope check
   * (there's no reliable way to assume scope from a token) — the 403 IS the
   * gate.
   */
  scopeError?: boolean;
}

/**
 * Create an issue on `owner/repo`. `labels` are passed through, but GitHub
 * silently discards them (along with assignees/milestone) when the filer lacks
 * push access — which is the common case here. The real label markers live in
 * the issue body; the `labels` field only takes effect for a filer who *does*
 * have push access (a ShipIt developer). Passing them unconditionally is
 * therefore safe: a no-op for regular users, a convenience for developers.
 */
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
        // 404 can also mean "token can't see this repo" — same user-facing
        // remedy as a 403 scope miss, so fold them together.
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
