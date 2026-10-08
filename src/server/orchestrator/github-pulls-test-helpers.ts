import { vi } from "vitest";

export interface FakePr { head: string; number: number; state: "open" | "closed"; merged_at?: string }

/**
 * GitHub as measured: a path under a repo's former name is answered through a
 * redirect that keeps the query string, and `head` selects the owner it names.
 */
export function mockGitHubPulls(
  repo: { formerly?: string; now: string; prs: FakePr[]; unreadableName?: boolean },
): URL[] {
  const requests: URL[] = [];
  const [owner, name] = repo.now.split("/");
  const oldPath = repo.formerly ? `/repos/${repo.formerly}` : null;
  const identity = { name, owner: { login: owner } };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url);
    const repoPath = [`/repos/${repo.now}`, oldPath].find(
      (p) => p && (url.pathname === p || url.pathname === `${p}/pulls`),
    );
    if (!repoPath || url.host !== "api.github.com" || (init?.method ?? "GET") !== "GET") {
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.href}`);
    }
    const isList = url.pathname.endsWith("/pulls");
    if (!isList && repo.unreadableName) throw new Error("socket hang up");
    const payload = isList
      ? repo.prs
        .filter((pr) => pr.head === url.searchParams.get("head"))
        .filter((pr) => url.searchParams.get("state") === "all" || pr.state === "open")
        .map((pr) => ({
          html_url: `https://github.com/${repo.now}/pull/${pr.number}`, number: pr.number,
          base: { ref: "main", repo: identity }, title: "Add a thing", body: null, state: pr.state,
          merged_at: pr.merged_at ?? null, merge_commit_sha: null, head: { sha: "h1" },
          additions: 3, deletions: 1,
        }))
      : identity;
    const res = new Response(JSON.stringify(payload), { status: 200 });
    if (oldPath && (url.pathname === oldPath || url.pathname.startsWith(`${oldPath}/`))) {
      Object.defineProperty(res, "redirected", { value: true });
    }
    return res;
  });
  return requests;
}
