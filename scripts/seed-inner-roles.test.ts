import { describe, it, expect } from "vitest";
import {
  RECIPES,
  UNAVAILABLE_ROLE_NAME,
  planRoles,
  planUnavailableRole,
  resolveRecipe,
  runnableHarnesses,
  seedRoles,
  type BootstrapAgent,
  type FetchImpl,
} from "./seed-inner-roles.js";
import { catalogueEntriesForHarness } from "../src/server/shared/catalogue/index.js";

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

/** A harness as bootstrap reports it, with only the fields under test spelled out. */
function agent(over: Partial<BootstrapAgent> & { id: string }): BootstrapAgent {
  return {
    name: over.id,
    installed: true,
    eligibleModels: [{ serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5", label: "Opus 5" }],
    reasoning: { options: [{ value: "low", label: "Low" }, { value: "max", label: "Max" }] },
    ...over,
  };
}

const CLAUDE = agent({ id: "claude" });
const CODEX = agent({
  id: "codex",
  eligibleModels: [{ serviceId: "xai", billingMode: "key", modelId: "grok-4.6", label: "Grok 4.6" }],
  reasoning: { options: [{ value: "none", label: "None" }, { value: "high", label: "High" }] },
});

const bootstrapOf = (settings: unknown): Record<string, { body: unknown }> => ({
  "GET /api/bootstrap": { body: { settings } },
});

describe("runnableHarnesses", () => {
  it("keeps only harnesses that are installed and have an eligible model", () => {
    const found = runnableHarnesses([
      CLAUDE,
      agent({ id: "codex", installed: false }),
      agent({ id: "opencode", eligibleModels: [] }),
      agent({ id: "grok", eligibleModels: undefined }),
    ]);
    expect(found.map((h) => h.id)).toEqual(["claude"]);
  });
});

describe("resolveRecipe", () => {
  const recipe = RECIPES.find((r) => r.name === "deep-dive")!;

  it("takes its tuple from the install rather than a hardcoded one", () => {
    // The same recipe against two different installs must produce two different
    // tuples — that is the whole contract, and a hardcoded tuple would pass a
    // test that only ever looked at one install.
    expect(resolveRecipe(recipe, [CLAUDE])!.params).toEqual({
      kind: "pinned",
      harnessId: "claude",
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
      reasoningEffort: "max",
    });
    expect(resolveRecipe(recipe, [CODEX])!.params).toEqual({
      kind: "pinned",
      harnessId: "codex",
      serviceId: "xai",
      billingMode: "key",
      modelId: "grok-4.6",
      reasoningEffort: "high",
    });
  });

  it("reads `highest` and `lowest` off the harness's own declared levels", () => {
    const quick = RECIPES.find((r) => r.name === "quick-look")!;
    expect(resolveRecipe(quick, [CLAUDE])!.params.reasoningEffort).toBe("low");
    expect(resolveRecipe(quick, [CODEX])!.params.reasoningEffort).toBe("none");
  });

  it("omits the level entirely for Default, rather than sending an empty string", () => {
    // docs/264-agent-roles req 1 — Default is the ABSENCE of the key, and
    // `roles["…"].params.reasoningEffort` is refused when present and blank.
    const second = RECIPES.find((r) => r.name === "second-opinion")!;
    const params = resolveRecipe(second, [CLAUDE, CODEX])!.params;
    expect(params).not.toHaveProperty("reasoningEffort");
  });

  it("omits the level on a harness that declares none (docs/274 req 8)", () => {
    const bare = agent({ id: "grok", reasoning: { options: [] } });
    expect(resolveRecipe(recipe, [bare])!.params).not.toHaveProperty("reasoningEffort");
  });

  it("skips a `secondary` recipe where the install runs only one harness", () => {
    const second = RECIPES.find((r) => r.name === "second-opinion")!;
    expect(resolveRecipe(second, [CLAUDE])).toBeUndefined();
    expect(resolveRecipe(second, [CLAUDE, CODEX])!.params.harnessId).toBe("codex");
  });

  it("carries the description, and the standing instructions where the recipe has them", () => {
    const deep = resolveRecipe(recipe, [CLAUDE])!;
    expect(deep.description).toBeTruthy();
    expect(deep.prompt).toBeTruthy();
    const quick = resolveRecipe(RECIPES.find((r) => r.name === "quick-look")!, [CLAUDE])!;
    expect(quick.description).toBeTruthy();
    expect(quick.prompt).toBeUndefined();
  });
});

describe("the recipe set itself", () => {
  it("covers what the role surfaces need to be worth looking at", () => {
    const planned = RECIPES.map((r) => resolveRecipe(r, [CLAUDE, CODEX])!);
    expect(planned.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    // Different reasoning levels — a set where every role ran at the same level
    // would leave the level control untestable by eye.
    const levels = new Set(planned.map((p) => p.params.reasoningEffort));
    expect(levels.size).toBeGreaterThanOrEqual(2);
    // At least one with BOTH a description and standing instructions (reqs 8, 9).
    expect(planned.some((p) => p.description && p.prompt)).toBe(true);
  });

  it("every recipe describes what it is for, since the agent reads that (req 19)", () => {
    for (const recipe of RECIPES) expect(recipe.description.length).toBeGreaterThan(40);
  });
});

describe("planUnavailableRole", () => {
  it("names a real catalogue tuple this install holds no credential for", () => {
    const role = planUnavailableRole([CLAUDE])!;
    expect(role.name).toBe(UNAVAILABLE_ROLE_NAME);
    expect(role.params.harnessId).toBe("claude");
    // Catalogue-valid — otherwise the save is refused outright (req 6) and the
    // role never exists to be shown as disabled.
    const entries = catalogueEntriesForHarness("claude");
    expect(
      entries.some(
        (e) =>
          e.selection.serviceId === role.params.serviceId
          && e.selection.billingMode === role.params.billingMode
          && e.selection.modelId === role.params.modelId,
      ),
    ).toBe(true);
    // …and NOT one the install can run, or it would resolve happily.
    expect(role.params.modelId).not.toBe("claude-opus-5");
    expect(role.description).toContain("deliberately unavailable");
  });

  it("plans nothing where the install can already run everything its harness carries", () => {
    const everything = agent({
      id: "claude",
      eligibleModels: catalogueEntriesForHarness("claude").map((e) => ({
        serviceId: e.selection.serviceId,
        billingMode: e.selection.billingMode,
        modelId: e.selection.modelId,
        label: e.model.label,
      })),
    });
    expect(planUnavailableRole([everything])).toBeUndefined();
  });
});

describe("planRoles", () => {
  it("plans the runnable recipes plus the unavailable one", () => {
    const names = planRoles({ agents: [CLAUDE, CODEX], roles: [{ name: "reviewer" }] }).map((r) => r.name);
    expect(names).toEqual(["deep-dive", "quick-look", "second-opinion", UNAVAILABLE_ROLE_NAME]);
  });

  it("leaves a role whose name already exists completely alone (req 4)", () => {
    const planned = planRoles({
      agents: [CLAUDE, CODEX],
      roles: [{ name: "reviewer" }, { name: "deep-dive" }],
    });
    expect(planned.map((r) => r.name)).not.toContain("deep-dive");
  });

  it("never plans the reserved reviewer, even if the settings read omitted it", () => {
    // Its params are ShipIt's to resolve (docs/264-agent-roles req 2), so naming
    // it here could only ever produce a 400.
    const withReviewerRecipe = planRoles({ agents: [CLAUDE], roles: [] });
    expect(withReviewerRecipe.map((r) => r.name)).not.toContain("reviewer");
  });
});

describe("seedRoles", () => {
  const opts = { pollIntervalMs: 1, timeoutMs: 50 };

  it("writes one role per request, as a create", async () => {
    const { fetchImpl, calls } = fakeFetch({
      ...bootstrapOf({ agents: [CLAUDE, CODEX], roles: [{ name: "reviewer" }] }),
      "PUT /api/settings": { body: {} },
    });
    const result = await seedRoles({ fetchImpl, baseUrl: "http://orch", env: {} }, opts);
    expect(result.results.map((r) => r.outcome)).toEqual(["seeded", "seeded", "seeded", "seeded"]);
    const puts = calls.filter((c) => c.method === "PUT");
    // One PUT each (req 5): `applyRoleWrites` validates a batch before writing
    // any of it, so one refused role in a batch would take the others with it.
    expect(puts).toHaveLength(4);
    for (const put of puts) {
      const body = put.body as { roles: Record<string, { previousName?: string; params: unknown }> };
      expect(Object.keys(body.roles)).toHaveLength(1);
      // No `previousName` — every seeded role is a create, and claiming to edit
      // one that does not exist is refused.
      expect(Object.values(body.roles)[0]).not.toHaveProperty("previousName");
      expect(Object.values(body.roles)[0]!.params).toMatchObject({ kind: "pinned" });
    }
    expect(Object.keys((puts[0]!.body as { roles: object }).roles)).toEqual(["deep-dive"]);
  });

  it("is a no-op when no harness on the install can run anything", async () => {
    const { fetchImpl, calls } = fakeFetch(
      bootstrapOf({ agents: [agent({ id: "claude", eligibleModels: [] })], roles: [] }),
    );
    const result = await seedRoles({ fetchImpl, baseUrl: "http://orch", env: {} }, opts);
    expect(result).toEqual({ skipped: true, results: [] });
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("writes nothing when every seeded role is already present (req 4)", async () => {
    const roles = [
      { name: "reviewer" },
      ...RECIPES.map((r) => ({ name: r.name })),
      { name: UNAVAILABLE_ROLE_NAME },
    ];
    const { fetchImpl, calls } = fakeFetch(bootstrapOf({ agents: [CLAUDE, CODEX], roles }));
    const result = await seedRoles({ fetchImpl, baseUrl: "http://orch", env: {} }, opts);
    expect(result).toEqual({ skipped: true, results: [] });
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("carries on after one role fails (req 5)", async () => {
    let puts = 0;
    const { fetchImpl } = fakeFetch({
      ...bootstrapOf({ agents: [CLAUDE, CODEX], roles: [] }),
      "PUT /api/settings": { body: {} },
    });
    const failing = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT" && puts++ === 0) throw new Error("connection reset");
      return fetchImpl(input, init);
    }) as unknown as FetchImpl;
    const result = await seedRoles({ fetchImpl: failing, baseUrl: "http://orch", env: {} }, opts);
    expect(result.results.map((r) => r.outcome)).toEqual(["failed", "seeded", "seeded", "seeded"]);
  });

  it("reports the server's refusal verbatim rather than throwing", async () => {
    const { fetchImpl } = fakeFetch({
      ...bootstrapOf({ agents: [CLAUDE], roles: [] }),
      "PUT /api/settings": { status: 400, body: { error: 'A role named "deep-dive" already exists.' } },
    });
    const result = await seedRoles({ fetchImpl, baseUrl: "http://orch", env: {} }, opts);
    expect(result.results[0]).toEqual({
      name: "deep-dive",
      outcome: "failed",
      detail: 'A role named "deep-dive" already exists.',
    });
  });

  it("honours DOGFOOD_SEED=0 and DOGFOOD_SEED_ROLES=0 (req 3)", async () => {
    const { fetchImpl, calls } = fakeFetch(bootstrapOf({ agents: [CLAUDE], roles: [] }));
    for (const env of [{ DOGFOOD_SEED: "0" }, { DOGFOOD_SEED_ROLES: "0" }]) {
      expect((await seedRoles({ fetchImpl, baseUrl: "http://orch", env }, opts)).skipped).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("gives up quietly when the orchestrator never answers", async () => {
    const { fetchImpl } = fakeFetch({ "GET /api/bootstrap": { status: 503 } });
    const result = await seedRoles({ fetchImpl, baseUrl: "http://orch", env: {} }, opts);
    expect(result).toEqual({ skipped: true, results: [] });
  });
});

// The guard that this seeder is actually RUN at boot — the failure mode a unit
// test cannot otherwise see, since every seeder exits 0 on failure and so
// "seeded nothing" and "was never launched" look identical in the logs — lives
// in `seed-inner.test.ts`, next to the entry point that owns the step order.
