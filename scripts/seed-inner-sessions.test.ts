import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-expect-error — plain-Node script (no build step, so it stays .js); this
// test drives its exported functions with a fake fetch.
import { seed, readFixture, canonicalRepoKey, FIXTURE_PATH } from "./seed-inner-sessions.js";

/**
 * Unit coverage for the dogfood seed (docs/131 reqs 2–5).
 *
 * The script's whole job is a sequence of HTTP calls against the inner
 * orchestrator, so these drive it with a fake `fetch` and assert on the calls it
 * makes. What matters is not "did it call an endpoint" but the properties the
 * requirements name: don't redo work (req 4), don't let one bad entry stop the
 * rest (req 5), and stay off entirely when told to (req 3).
 */

interface Call { method: string; route: string; body?: unknown }

/**
 * Fake orchestrator. `repos` is the mutable registered-repo list; adding a repo
 * flips it to `ready` immediately unless `cloneFails` names it, which models the
 * background clone the real `POST /api/repos` kicks off.
 */
function fakeOrch(opts: {
  repos?: { url: string; status: string }[];
  failAdd?: string[];
  failTrust?: string[];
  neverReady?: string[];
  authenticated?: boolean;
} = {}) {
  const repos = [...(opts.repos ?? [])];
  const calls: Call[] = [];

  const json = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  const fetchImpl = async (url: string, init: { method: string; body?: string }) => {
    const route = url.replace(/^https?:\/\/[^/]+/, "");
    const body: unknown = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, route, ...(body === undefined ? {} : { body }) });

    if (route === "/api/bootstrap") {
      return json(200, { githubStatus: { authenticated: opts.authenticated ?? true } });
    }
    if (route === "/api/repos" && init.method === "GET") {
      return json(200, { repos });
    }
    if (route === "/api/repos" && init.method === "POST") {
      const target = (body as { url: string }).url;
      if (opts.failAdd?.includes(target)) return json(400, { error: "Invalid repository URL" });
      // Upsert, like the real `addRepo` — re-adding a known repo updates the
      // existing row rather than creating a second one.
      const status = opts.neverReady?.includes(target) ? "cloning" : "ready";
      const existing = repos.find((r) => r.url === target);
      if (existing) existing.status = status;
      else repos.push({ url: target, status });
      return json(200, { repo: { url: target } });
    }
    if (route === "/api/repos/trust") {
      const target = (body as { url: string }).url;
      if (opts.failTrust?.includes(target)) return json(500, { error: "trust exploded" });
      return json(200, { trusted: true });
    }
    return json(404, { error: `unexpected route ${route}` });
  };

  return { fetchImpl, calls, repos };
}

/** Write a throwaway fixture and return its path. */
function fixture(repos: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-fixture-"));
  const file = path.join(dir, "dogfood-seed.json");
  fs.writeFileSync(file, JSON.stringify({ repos }));
  return file;
}

// No real sleeping: the script polls on a 1s interval, and every poll in these
// tests is satisfied on the first attempt.
const FAST = { pollIntervalMs: 0 };

const A = "https://github.com/acme/repo-a";
const B = "https://github.com/acme/repo-b";

describe("dogfood seed script", () => {
  it("adds, waits for ready, then trusts — in that order (reqs 1, 8)", async () => {
    const orch = fakeOrch();
    const result = await seed(
      { fetchImpl: orch.fetchImpl, baseUrl: "http://orch", env: {} },
      { ...FAST, fixturePath: fixture([{ url: A }]) },
    );

    expect(result.results).toEqual([{ url: A, outcome: "seeded" }]);
    // Trust must come after the add: an untrusted repo fails every agent
    // dispatch with 403 `repository_untrusted` (docs/178), which is what makes
    // it part of seeding rather than a separate concern.
    const mutations = orch.calls.filter((c) => c.method === "POST").map((c) => c.route);
    expect(mutations).toEqual(["/api/repos", "/api/repos/trust"]);
  });

  it("skips repos that are already registered and ready (req 4)", async () => {
    const orch = fakeOrch({ repos: [{ url: `${A}.git`, status: "ready" }] });
    const result = await seed(
      { fetchImpl: orch.fetchImpl, baseUrl: "http://orch", env: {} },
      { ...FAST, fixturePath: fixture([{ url: A }]) },
    );

    expect(result.results).toEqual([{ url: A, outcome: "skipped" }]);
    // Nothing was added, re-cloned or re-trusted — a dev-service restart is a
    // no-op. Note the fixture omits the `.git` suffix the store canonicalizes
    // to; matching has to survive that.
    expect(orch.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("a repo still cloning is not treated as present (req 4)", async () => {
    // `status: "cloning"` means an earlier boot registered it but the clone
    // never finished. Skipping it there would leave the inner ShipIt with a
    // permanently half-added repo, so it gets seeded again.
    const orch = fakeOrch({ repos: [{ url: A, status: "cloning" }] });
    await seed(
      { fetchImpl: orch.fetchImpl, baseUrl: "http://orch", env: {} },
      { ...FAST, fixturePath: fixture([{ url: A }]) },
    );
    expect(orch.calls.some((c) => c.method === "POST" && c.route === "/api/repos")).toBe(true);
  });

  it("one bad entry does not stop the others (req 5)", async () => {
    const orch = fakeOrch({ failAdd: [A] });
    const result = await seed(
      { fetchImpl: orch.fetchImpl, baseUrl: "http://orch", env: {} },
      { ...FAST, fixturePath: fixture([{ url: A }, { url: B }]) },
    );

    expect(result.results[0]).toMatchObject({ url: A, outcome: "failed" });
    expect(result.results[1]).toEqual({ url: B, outcome: "seeded" });
  });

  it("a failed trust is reported, and later entries still run (req 5)", async () => {
    const orch = fakeOrch({ failTrust: [A] });
    const result = await seed(
      { fetchImpl: orch.fetchImpl, baseUrl: "http://orch", env: {} },
      { ...FAST, fixturePath: fixture([{ url: A }, { url: B }]) },
    );

    expect(result.results[0]).toMatchObject({ url: A, outcome: "failed" });
    expect(result.results[1]).toEqual({ url: B, outcome: "seeded" });
  });

  it("a clone that never finishes times out without wedging the rest (req 5)", async () => {
    const orch = fakeOrch({ neverReady: [A] });
    const result = await seed(
      { fetchImpl: orch.fetchImpl, baseUrl: "http://orch", env: {} },
      { ...FAST, readyTimeoutMs: 5, fixturePath: fixture([{ url: A }, { url: B }]) },
    );

    expect(result.results[0]).toMatchObject({ url: A, outcome: "failed" });
    expect(result.results[1]).toEqual({ url: B, outcome: "seeded" });
  });

  it("DOGFOOD_SEED=0 makes it a complete no-op (req 3)", async () => {
    const orch = fakeOrch();
    const result = await seed(
      { fetchImpl: orch.fetchImpl, baseUrl: "http://orch", env: { DOGFOOD_SEED: "0" } },
      { ...FAST, fixturePath: fixture([{ url: A }]) },
    );

    expect(result.skipped).toBe(true);
    // Not even a health probe — "off" means it never touches the orch.
    expect(orch.calls).toEqual([]);
  });

  it("an orch that never comes up is reported, not retried forever", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      throw new Error("ECONNREFUSED");
    };
    const result = await seed(
      { fetchImpl, baseUrl: "http://orch", env: {} },
      { ...FAST, timeoutMs: 5, fixturePath: fixture([{ url: A }]) },
    );

    expect(result.skipped).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("a missing fixture file seeds nothing and does not throw", async () => {
    const orch = fakeOrch();
    const result = await seed(
      { fetchImpl: orch.fetchImpl, baseUrl: "http://orch", env: {} },
      { ...FAST, fixturePath: "/nonexistent/dogfood-seed.json" },
    );
    expect(result).toEqual({ skipped: true, results: [] });
    expect(orch.calls).toEqual([]);
  });

  it("a malformed fixture seeds nothing and does not throw", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-fixture-"));
    const file = path.join(dir, "dogfood-seed.json");
    fs.writeFileSync(file, "{ this is not json");
    const orch = fakeOrch();
    const result = await seed(
      { fetchImpl: orch.fetchImpl, baseUrl: "http://orch", env: {} },
      { ...FAST, fixturePath: file },
    );
    expect(result).toEqual({ skipped: true, results: [] });
  });

  it("warns when the inner ShipIt has no GitHub login, but still seeds (req 7)", async () => {
    const orch = fakeOrch({ authenticated: false });
    const lines: string[] = [];
    const spy = console.log;
    console.log = (msg: string) => { lines.push(String(msg)); };
    try {
      const result = await seed(
        { fetchImpl: orch.fetchImpl, baseUrl: "http://orch", env: {} },
        { ...FAST, fixturePath: fixture([{ url: A }]) },
      );
      // The warning names the fix. Public repos still clone anonymously, so an
      // absent token degrades seeding rather than stopping it.
      expect(lines.some((l) => /GITHUB_TOKEN/.test(l))).toBe(true);
      expect(result.results).toEqual([{ url: A, outcome: "seeded" }]);
    } finally {
      console.log = spy;
    }
  });

  it("matches stored repo URLs the way the orchestrator canonicalizes them", () => {
    // Mirrors `canonicalRepoKey` in git-utils.ts — the store appends `.git`, so
    // a fixture written without it must still match on restart (req 4).
    expect(canonicalRepoKey("https://github.com/Acme/Repo.git"))
      .toBe(canonicalRepoKey("https://github.com/Acme/Repo/"));
  });

  it("accepts both object and bare-string fixture entries", async () => {
    const urls = await readFixture(fixture([{ url: A }, B, { nope: 1 }, ""]));
    expect(urls).toEqual([A, B]);
  });

  it("the committed fixture is valid and non-empty (req 2)", async () => {
    // Guards the actual file the dev service reads: a typo here means the inner
    // ShipIt silently comes up empty.
    const urls = await readFixture(FIXTURE_PATH);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(() => new URL(url)).not.toThrow();
  });
});
