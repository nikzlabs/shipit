import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  collectCandidates,
  seedCredentials,
  seededLabel,
  warnAboutAmbientAuth,
  type FetchImpl,
} from "./seed-inner-credentials.js";
import { credentialStorageEnvNames } from "../src/server/shared/catalogue/index.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A `fetch` double that records calls and answers from a route table. */
function fakeFetch(handlers: Record<string, { status?: number; body?: unknown }>): {
  fetchImpl: FetchImpl;
  calls: { method: string; url: string; body: unknown }[];
} {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${new URL(url).pathname}`;
    const handler = handlers[key] ?? { status: 404, body: { error: "no handler" } };
    const status = handler.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => handler.body ?? {},
    } as Response;
  }) as unknown as FetchImpl;
  return { fetchImpl, calls };
}

const OK_BOOTSTRAP = { "GET /api/bootstrap": { body: {} } };

describe("collectCandidates", () => {
  it("places a supplied variable on its catalogue (service, billing mode)", () => {
    const found = collectCandidates({ ZAI_CODING_PLAN_KEY: "glm-secret" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      envName: "ZAI_CODING_PLAN_KEY",
      serviceId: "zai",
      billingMode: "sub",
      secret: "glm-secret",
    });
  });

  it("ignores unset, empty and whitespace-only values", () => {
    expect(collectCandidates({})).toEqual([]);
    expect(collectCandidates({ ZAI_API_KEY: "", DEEPSEEK_API_KEY: "   " })).toEqual([]);
  });

  it("ignores variables the catalogue does not claim", () => {
    expect(collectCandidates({ GITHUB_TOKEN: "gh", PATH: "/usr/bin" })).toEqual([]);
  });

  it("covers every catalogue-declared credential name, not a hand-written subset", () => {
    const env = Object.fromEntries(credentialStorageEnvNames().map((name) => [name, "s"]));
    expect(collectCandidates(env).map((c) => c.envName)).toEqual(credentialStorageEnvNames());
  });

  it("distinguishes a service's sub and key modes", () => {
    const found = collectCandidates({ ZAI_CODING_PLAN_KEY: "a", ZAI_API_KEY: "b" });
    expect(found.map((c) => `${c.serviceId}:${c.billingMode}`)).toEqual(["zai:sub", "zai:key"]);
  });
});

describe("seededLabel", () => {
  it("names the provenance so an inner-UI edit is distinguishable", () => {
    const [plan] = collectCandidates({ ZAI_CODING_PLAN_KEY: "a" });
    const [key] = collectCandidates({ DEEPSEEK_API_KEY: "b" });
    expect(seededLabel(plan!)).toBe("GLM (Z.ai) plan (dogfood secret)");
    expect(seededLabel(key!)).toBe("DeepSeek key (dogfood secret)");
  });
});

describe("seedCredentials", () => {
  const opts = { pollIntervalMs: 1, timeoutMs: 50 };

  it("creates a credential route for each supplied variable", async () => {
    const { fetchImpl, calls } = fakeFetch({
      ...OK_BOOTSTRAP,
      "GET /api/credential-routes": { body: { routes: [] } },
      "POST /api/credential-routes": { body: { route: {}, routes: [] } },
    });
    const result = await seedCredentials(
      { fetchImpl, baseUrl: "http://orch", env: { ZAI_CODING_PLAN_KEY: "glm", DEEPSEEK_API_KEY: "ds" } },
      opts,
    );
    expect(result.results.map((r) => r.outcome)).toEqual(["seeded", "seeded"]);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.body)).toEqual([
      { serviceId: "deepseek", billingMode: "key", secret: "ds", label: "DeepSeek key (dogfood secret)" },
      { serviceId: "zai", billingMode: "sub", secret: "glm", label: "GLM (Z.ai) plan (dogfood secret)" },
    ]);
  });

  it("leaves a mode that already holds a string credential completely alone (req 4)", async () => {
    const { fetchImpl, calls } = fakeFetch({
      ...OK_BOOTSTRAP,
      "GET /api/credential-routes": {
        body: { routes: [{ serviceId: "zai", billingMode: "sub", via: "string" }] },
      },
      "POST /api/credential-routes": { body: {} },
    });
    const result = await seedCredentials(
      { fetchImpl, baseUrl: "http://orch", env: { ZAI_CODING_PLAN_KEY: "glm" } },
      opts,
    );
    expect(result.results).toEqual([{ envName: "ZAI_CODING_PLAN_KEY", outcome: "skipped" }]);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("does not treat a connected ACCOUNT as a reason to skip the string credential", async () => {
    // An account and a supplied token are different credentials of the same
    // mode — Anthropic's subscription accepts both — so an account must not
    // suppress the seed.
    const { fetchImpl, calls } = fakeFetch({
      ...OK_BOOTSTRAP,
      "GET /api/credential-routes": {
        body: { routes: [{ serviceId: "anthropic", billingMode: "sub", via: "account" }] },
      },
      "POST /api/credential-routes": { body: {} },
    });
    await seedCredentials(
      { fetchImpl, baseUrl: "http://orch", env: { ANTHROPIC_AUTH_TOKEN: "tok" } },
      opts,
    );
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("seeds nothing at all when the existing-route list cannot be read", async () => {
    // No server-side uniqueness key for a `sub` mode, so a blind POST after a
    // lost GET duplicates the credential once per boot.
    for (const listing of [{ status: 500, body: { error: "boom" } }, { body: {} }]) {
      const { fetchImpl, calls } = fakeFetch({
        ...OK_BOOTSTRAP,
        "GET /api/credential-routes": listing,
        "POST /api/credential-routes": { body: {} },
      });
      const result = await seedCredentials(
        { fetchImpl, baseUrl: "http://orch", env: { ZAI_CODING_PLAN_KEY: "glm" } },
        opts,
      );
      expect(result).toEqual({ skipped: true, results: [] });
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    }
  });

  it("carries on after one credential fails (req 5)", async () => {
    let posts = 0;
    const { fetchImpl } = fakeFetch({
      ...OK_BOOTSTRAP,
      "GET /api/credential-routes": { body: { routes: [] } },
      "POST /api/credential-routes": { body: {} },
    });
    const failing = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && posts++ === 0) throw new Error("connection reset");
      return fetchImpl(input, init);
    }) as unknown as FetchImpl;
    const result = await seedCredentials(
      { fetchImpl: failing, baseUrl: "http://orch", env: { ZAI_CODING_PLAN_KEY: "a", DEEPSEEK_API_KEY: "b" } },
      opts,
    );
    expect(result.results.map((r) => r.outcome).sort()).toEqual(["failed", "seeded"]);
  });

  it("reports an HTTP error rather than throwing", async () => {
    const { fetchImpl } = fakeFetch({
      ...OK_BOOTSTRAP,
      "GET /api/credential-routes": { body: { routes: [] } },
      "POST /api/credential-routes": { status: 409, body: { error: "already has an API key" } },
    });
    const result = await seedCredentials(
      { fetchImpl, baseUrl: "http://orch", env: { DEEPSEEK_API_KEY: "ds" } },
      opts,
    );
    expect(result.results).toEqual([
      { envName: "DEEPSEEK_API_KEY", outcome: "failed", detail: "already has an API key" },
    ]);
  });

  it("is a silent no-op when no service secret is set", async () => {
    const { fetchImpl, calls } = fakeFetch(OK_BOOTSTRAP);
    const result = await seedCredentials({ fetchImpl, baseUrl: "http://orch", env: {} }, opts);
    expect(result.skipped).toBe(true);
    // Not even the health probe: a developer with no secrets pays nothing.
    expect(calls).toHaveLength(0);
  });

  it("honours DOGFOOD_SEED=0 and DOGFOOD_SEED_CREDENTIALS=0 (req 3)", async () => {
    const { fetchImpl, calls } = fakeFetch(OK_BOOTSTRAP);
    for (const env of [
      { ZAI_API_KEY: "a", DOGFOOD_SEED: "0" },
      { ZAI_API_KEY: "a", DOGFOOD_SEED_CREDENTIALS: "0" },
    ]) {
      expect((await seedCredentials({ fetchImpl, baseUrl: "http://orch", env }, opts)).skipped).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("gives up quietly when the orchestrator never answers", async () => {
    const { fetchImpl } = fakeFetch({ "GET /api/bootstrap": { status: 503 } });
    const result = await seedCredentials(
      { fetchImpl, baseUrl: "http://orch", env: { ZAI_API_KEY: "a" } },
      opts,
    );
    expect(result).toEqual({ skipped: true, results: [] });
  });
});

describe("warnAboutAmbientAuth", () => {
  it("warns that ANY metered key can become what background work spends on", () => {
    // Not just the vendor-native names: `firstEligibleNonTurnSelection` walks
    // the catalogue over whatever credentials exist.
    const lines = warnAboutAmbientAuth(collectCandidates({ DEEPSEEK_API_KEY: "k" }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("DEEPSEEK_API_KEY");
    expect(lines[0]).toContain("metered (billed per token)");
    expect(lines[0]).toContain("Background work");
  });

  it("adds the CLI-bypass warning for a vendor-native name", () => {
    const lines = warnAboutAmbientAuth(collectCandidates({ ANTHROPIC_API_KEY: "k" }));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("read by the CLI");
  });

  it("warns about a subscription token's precedence without calling it metered", () => {
    const lines = warnAboutAmbientAuth(collectCandidates({ ANTHROPIC_AUTH_TOKEN: "t" }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("read by the CLI");
    expect(lines[0]).not.toContain("metered");
  });

  it("says nothing for a subscription delivered under a ShipIt-owned name", () => {
    expect(warnAboutAmbientAuth(collectCandidates({ ZAI_CODING_PLAN_KEY: "a" }))).toEqual([]);
  });
});

/**
 * The guard the scope depends on: `x-shipit-secrets` is static YAML and cannot
 * enumerate the catalogue, so adding a service would silently make it
 * untestable in dogfood. This fails the build instead, naming the missing key.
 */
describe("the dev service's x-shipit-secrets block", () => {
  const compose = parse(readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8")) as {
    services: Record<string, { "x-shipit-secrets"?: { name: string }[] }>;
  };
  const declared = (compose.services.dev["x-shipit-secrets"] ?? []).map((entry) => entry.name);

  it("declares every credential variable the catalogue names", () => {
    const missing = credentialStorageEnvNames().filter((name) => !declared.includes(name));
    expect(
      missing,
      `docker-compose.yml's \`dev\` service is missing ${missing.join(", ")} from its`
      + " `x-shipit-secrets` block, so that service cannot be tested in dogfood."
      + " Add `- { name: <NAME> }` for each.",
    ).toEqual([]);
  });

  // Deliberately NOT asserted: that the block contains nothing else. The dev
  // service may legitimately need an unrelated secret (`GITHUB_TOKEN` already
  // is one), and forbidding that would make this guard block work it has no
  // opinion about. A stale entry left by a renamed `storageEnv` is
  // indistinguishable from a deliberate one, so it is not worth the false
  // positives. (Cross-agent review found the earlier assertion too strict.)

  it("declares no duplicate names", () => {
    expect(declared).toEqual([...new Set(declared)]);
  });
});

/**
 * The mirror image of the guard above, and the whole reason the `onboarding`
 * service exists (docs/118).
 *
 * That service is a ShipIt that has never been set up, so the first-run flow
 * can be exercised without deleting the developer's real keys. What makes it
 * uncredentialed is precisely what it does NOT declare: a name in
 * `x-shipit-secrets` is what injects the value, `adoptEnvCredentials` turns an
 * injected service variable into a stored credential at boot (docs/252 req 20),
 * and `resolveHarnessOnboarding` then stamps the install as onboarded —
 * permanently, since nothing clears that stamp.
 *
 * So a single line added here in good faith ("it needs a key to be useful")
 * silently converts the fresh instance into a second configured one, and the
 * symptom is an absence: the panel under test never appears. `GITHUB_TOKEN` is
 * allowed and deliberate — the services onboarding is the subject, and making
 * the developer re-paste a GitHub token to reach it is friction rather than
 * coverage. Every catalogue `storageEnv` is not.
 *
 * Unlike the `dev` block, exact-membership IS asserted here: this list has no
 * legitimate reason to grow, and the failure it prevents is invisible.
 */
describe("the onboarding service's x-shipit-secrets block", () => {
  const compose = parse(readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8")) as {
    services: Record<string, { "x-shipit-secrets"?: { name: string }[] }>;
  };
  const declared = (compose.services.onboarding["x-shipit-secrets"] ?? []).map((e) => e.name);

  it("declares no service credential at all", () => {
    const offenders = credentialStorageEnvNames().filter((name) => declared.includes(name));
    expect(
      offenders,
      `docker-compose.yml's \`onboarding\` service declares ${offenders.join(", ")}, which is`
      + " injected, adopted into a stored credential at boot, and stamps the install as"
      + " onboarded. The service exists to be uncredentialed — that is what makes the"
      + " first-run flow reachable. Test that credential in `dev` instead.",
    ).toEqual([]);
  });

  it("declares GitHub and nothing else", () => {
    expect(declared).toEqual(["GITHUB_TOKEN"]);
  });
});
