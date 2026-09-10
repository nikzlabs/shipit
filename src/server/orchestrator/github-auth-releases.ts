import { fetchGitHub } from "./github-api.js";

export interface ReleaseByTag {
  name: string;
  body: string;
  htmlUrl: string;
  prerelease: boolean;
  publishedAt: string | null;
  tagName: string;
}

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
