/**
 * GitHub release operations — extracted from GitHubAuthManager (docs/171).
 *
 * Phase 1 is READ-ONLY: the agent pushes a tag and the repo's own CI publishes
 * the GitHub Release (tag-triggered, option (a)). The orchestrator only needs
 * to *read* the published Release back to render it inline. The write-side
 * `createRelease()` is deliberately NOT here — it is Phase 4 (orchestrator-
 * brokered releases), gated on product sign-off, and would re-open a capability
 * the `gh` shim intentionally blocks.
 */

import { fetchGitHub } from "./github-api.js";

export interface ReleaseByTag {
  /** Release name; falls back to the tag name when GitHub omits it. */
  name: string;
  /** Release body — grouped notes markdown. */
  body: string;
  /** Link-out to the Release on GitHub. */
  htmlUrl: string;
  prerelease: boolean;
  publishedAt: string | null;
  tagName: string;
}

/**
 * Read a published GitHub Release by its tag
 * (`GET /repos/{owner}/{repo}/releases/tags/{tag}`). Returns null when no
 * Release exists for the tag yet (the common "tag pushed, CI hasn't published
 * the Release" window) or on any API error.
 */
export async function getReleaseByTag(
  token: string,
  owner: string,
  repo: string,
  tag: string,
): Promise<ReleaseByTag | null> {
  try {
    const res = await fetchGitHub(
      `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      token,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      name: string | null;
      body: string | null;
      html_url: string;
      prerelease: boolean;
      published_at: string | null;
      tag_name: string;
    };
    return {
      name: data.name ?? data.tag_name,
      body: data.body ?? "",
      htmlUrl: data.html_url,
      prerelease: data.prerelease,
      publishedAt: data.published_at,
      tagName: data.tag_name,
    };
  } catch {
    return null;
  }
}
