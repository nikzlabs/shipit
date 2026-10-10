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

const MAX_ERROR_CAUSES = 3;
const MAX_ERROR_CAUSES_LENGTH = 300;

// GitHub puts the reason for a validation error in `errors`: a `message`, or a `field` and a
// `code`.
function errorCauses(errors: unknown): string {
  if (!Array.isArray(errors)) return "";
  const causes: string[] = [];
  for (const entry of errors.slice(0, MAX_ERROR_CAUSES) as unknown[]) {
    let cause = "";
    if (typeof entry === "string") {
      cause = entry;
    } else if (typeof entry === "object" && entry !== null) {
      const { message, field, code } = entry as Record<string, unknown>;
      cause = typeof message === "string" && message.trim()
        ? message
        : [field, code].filter((part) => typeof part === "string" && part.trim()).join(": ");
    }
    // The text can repeat a value that a user wrote: one line, and no control characters.
    cause = cause.slice(0, MAX_ERROR_CAUSES_LENGTH).replace(/[\s\p{Cc}]+/gu, " ").trim();
    if (cause) causes.push(cause);
  }
  const text = causes.join("; ");
  return text.length > MAX_ERROR_CAUSES_LENGTH ? `${text.slice(0, MAX_ERROR_CAUSES_LENGTH - 1)}…` : text;
}

export async function parseGitHubError(res: Response): Promise<string> {
  let message = "";
  let causes = "";
  try {
    const err = (await res.json()) as { message?: unknown; errors?: unknown };
    if (typeof err.message === "string") message = err.message;
    causes = errorCauses(err.errors);
  } catch {
    // body wasn't JSON — fall through to status-based message
  }
  if (!message) {
    message = res.statusText
      ? `GitHub API returned ${res.status} ${res.statusText}`
      : `GitHub API returned ${res.status}`;
  }
  if (causes) message = `${message}: ${causes}`;
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
