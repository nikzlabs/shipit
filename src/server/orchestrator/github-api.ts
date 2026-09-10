export function githubHeaders(token: string): {
  Authorization: string;
  Accept: string;
  "User-Agent": string;
} {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "ShipIt",
  };
}

export function fetchGitHub(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(githubHeaders(token));
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return fetch(url, { ...init, headers });
}

export async function parseGitHubError(res: Response): Promise<string> {
  try {
    const err = (await res.json()) as { message?: string };
    if (err.message) return err.message;
  } catch {
    // body wasn't JSON — fall through to status-based message
  }
  return res.statusText
    ? `GitHub API returned ${res.status} ${res.statusText}`
    : `GitHub API returned ${res.status}`;
}

export function fetchGitHubGraphQL(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Response> {
  return fetchGitHub("https://api.github.com/graphql", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}
