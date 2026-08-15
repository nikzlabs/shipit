/**
 * docs/264 phase 3 (req 12) — the two agent-facing reads.
 *
 * Both answer "what may I name?", and the property that matters in each is that
 * the answer describes **this install** rather than the catalogue: a role that
 * cannot run is still nameable (with its reason), and a harness or model this
 * install cannot run is not offered at all. Offering one would hand the agent a
 * value the validator then refuses, which is exactly the round trip the reads
 * exist to remove.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentRole, CredentialRoute, ReviewerSlot } from "../../shared/types.js";

function route(serviceId: string, billingMode: "sub" | "key"): CredentialRoute {
  return {
    serviceId,
    billingMode,
    id: `${serviceId}-${billingMode}`,
    via: "string",
    status: "ready",
    priority: 0,
    isPrimary: true,
    label: "test",
    createdAt: 0,
    updatedAt: 0,
  };
}

const REVIEWER: AgentRole = { name: "reviewer", params: { kind: "auto" } };

function storeWith(routes: CredentialRoute[], roles: AgentRole[]) {
  const all = [...roles, REVIEWER];
  return {
    getReviewerPin: (_slot: ReviewerSlot) => undefined,
    getRoles: () => [...all].sort((a, b) => a.name.localeCompare(b.name)),
    getRole: (name: string) => all.find((r) => r.name === name),
    listCredentialRoutes: (serviceId?: string, billingMode?: string) =>
      routes.filter(
        (r) =>
          (serviceId === undefined || r.serviceId === serviceId)
          && (billingMode === undefined || r.billingMode === billingMode),
      ),
    getCredentialSecret: (id: string) => (routes.some((r) => r.id === id) ? "sk-test" : undefined),
    getSelectionMode: () => "strict" as const,
    getCredentialRoute: (id: string) => routes.find((r) => r.id === id),
    getFailoverCutoffs: () => ({ session: 90, weekly: 90 }),
  };
}

const ANTHROPIC_KEY = route("anthropic", "key");

const RUNNABLE: AgentRole = {
  name: "deep dive",
  description: "Slow, thorough review",
  params: {
    kind: "pinned",
    harnessId: "claude",
    serviceId: "anthropic",
    billingMode: "key",
    modelId: "claude-opus-5",
    reasoningEffort: "high",
  },
};

/** A role whose model has left the catalogue — stranded, and still nameable. */
const STRANDED: AgentRole = {
  name: "ghost",
  params: {
    kind: "pinned",
    harnessId: "claude",
    serviceId: "anthropic",
    billingMode: "key",
    modelId: "claude-opus-1-imaginary",
    reasoningEffort: "high",
  },
};

describe("listRolesForAgent (req 12)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("../../shared/installed-harnesses.js");
  });

  it("lists every role with what it is for and what it runs on", async () => {
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));
    const { listRolesForAgent } = await import("./spawn-inventory.js");
    const roles = listRolesForAgent({
      credentialStore: storeWith([ANTHROPIC_KEY], [RUNNABLE]),
      env: {},
    });
    const deepDive = roles.find((r) => r.name === "deep dive");
    expect(deepDive?.description).toBe("Slow, thorough review");
    expect(deepDive?.runsOn).toContain("Opus 5");
    expect(deepDive?.unavailable).toBeUndefined();
  });

  // req 2 — the reviewer is always present, including on an install nobody has
  // configured, and it lists no model because its params are resolved per run.
  it("always includes the reviewer, with no fixed model", async () => {
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));
    const { listRolesForAgent } = await import("./spawn-inventory.js");
    const roles = listRolesForAgent({ credentialStore: storeWith([], []), env: {} });
    const reviewer = roles.find((r) => r.name === "reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer?.runsOn).toBeUndefined();
  });

  /**
   * A role that cannot run stays in the list, with the reason. Dropping it would
   * read as "no such role" and send the agent to invent a different one — and
   * the three unavailable states need three different remedies (req 7), so the
   * reason travels with the name rather than being flattened to "broken".
   */
  it("keeps an unrunnable role listed, carrying its reason", async () => {
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));
    const { listRolesForAgent } = await import("./spawn-inventory.js");
    const roles = listRolesForAgent({
      credentialStore: storeWith([ANTHROPIC_KEY], [STRANDED]),
      env: {},
    });
    const ghost = roles.find((r) => r.name === "ghost");
    expect(ghost).toBeDefined();
    expect(ghost?.unavailable).toBe("stranded");
    expect(ghost?.runsOn).toBeUndefined();
  });
});

describe("listSpawnParameters (req 12)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("../../shared/installed-harnesses.js");
  });

  const registryWith = (harnesses: unknown[]) => ({ list: () => harnesses }) as never;

  it("reports each installed harness's levels and credentialed models", async () => {
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));
    const { listSpawnParameters } = await import("./spawn-inventory.js");
    const inventory = listSpawnParameters(
      registryWith([
        {
          id: "codex",
          name: "Codex",
          capabilities: { reasoning: { label: "Effort", options: [{ value: "high", label: "High" }] } },
          eligibleModels: [
            {
              serviceId: "openai",
              billingMode: "key",
              modelId: "gpt-5.6-sol",
              label: "GPT-5.6 Sol",
              serviceName: "OpenAI",
              canonicalModelKey: "gpt-5.6-sol",
            },
          ],
        },
      ]),
    );
    expect(inventory.harnesses).toHaveLength(1);
    expect(inventory.harnesses[0].reasoningLevels).toEqual(["high"]);
    expect(inventory.harnesses[0].models[0]).toEqual({
      serviceId: "openai",
      billingMode: "key",
      modelId: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
    });
  });

  /**
   * A harness this deployment did not install is not a parameter an override may
   * name, so it is omitted rather than listed-and-refused. The gate asks the
   * DECLARED install set, matching every other spawn-adjacent check.
   */
  it("omits a harness this deployment did not install", async () => {
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: (id: string) => id === "codex",
      readInstalledHarnesses: () => ["codex"],
    }));
    const { listSpawnParameters } = await import("./spawn-inventory.js");
    const inventory = listSpawnParameters(
      registryWith([
        { id: "claude", name: "Claude Code", capabilities: {}, eligibleModels: [] },
        { id: "codex", name: "Codex", capabilities: {}, eligibleModels: [] },
      ]),
    );
    expect(inventory.harnesses.map((h) => h.id)).toEqual(["codex"]);
  });

  // An installed harness with no credential is still listed, with an empty model
  // list: "installed but nothing to run" and "not installed" are different
  // situations with different remedies, and collapsing them hides one.
  it("lists an installed harness with no eligible model as having none", async () => {
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude"],
    }));
    const { listSpawnParameters } = await import("./spawn-inventory.js");
    const inventory = listSpawnParameters(
      registryWith([{ id: "claude", name: "Claude Code", capabilities: {}, eligibleModels: [] }]),
    );
    expect(inventory.harnesses[0].models).toEqual([]);
    expect(inventory.harnesses[0].reasoningLevels).toEqual([]);
  });
});
