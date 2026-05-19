/**
 * Shared GitHub API plumbing — headers, fetch wrapper, error parsing.
 *
 * Consumed by the sibling `github-auth-*.ts` modules. Intentionally minimal:
 * this layer does NOT impose error-handling semantics (some callers throw,
 * some return `{ success: false, message }`, some silently return `[]`).
 * Callers decide what to do when `res.ok` is false.
 */

/**
 * Standard REST headers for GitHub API requests.
 * Callers that POST/PATCH/PUT JSON should spread this and add
 * `"Content-Type": "application/json"`.
 */
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

/**
 * Thin wrapper around `fetch` that injects the standard GitHub headers.
 * Caller-supplied `init.headers` win on conflict (e.g., to add
 * `"Content-Type": "application/json"` for write requests).
 *
 * Does NOT inspect the response — callers handle `!res.ok` themselves so
 * each callsite preserves its own error convention.
 */
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

/**
 * Best-effort extraction of a human-readable error message from a failed
 * GitHub API response. Handles the standard `{ message }` JSON shape and
 * falls back to status code / status text when the body isn't JSON or
 * lacks a `message` field.
 */
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

/**
 * POST a GraphQL query to GitHub's v4 endpoint. Sends the JSON body and
 * Content-Type header. Caller still handles `!res.ok` and any `errors`
 * array in the response payload.
 */
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
