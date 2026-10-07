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
  let message = "";
  try {
    const err = (await res.json()) as { message?: string };
    if (err.message) message = err.message;
  } catch {
    // body wasn't JSON — fall through to status-based message
  }
  if (!message) {
    message = res.statusText
      ? `GitHub API returned ${res.status} ${res.statusText}`
      : `GitHub API returned ${res.status}`;
  }
  // GitHub Support traces a server error by this id; nothing else in a 5xx identifies the request.
  const requestId = res.status >= 500 ? res.headers.get("x-github-request-id") : null;
  return requestId ? `${message} (GitHub request id ${requestId})` : message;
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
