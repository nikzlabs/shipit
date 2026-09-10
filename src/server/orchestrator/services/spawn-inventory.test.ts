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

  it("offers no level for a harness whose only rows discard the flag", async () => {
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["grok"],
    }));
    const { listSpawnParameters } = await import("./spawn-inventory.js");
    const keyOnly = listSpawnParameters(
      registryWith([
        {
          id: "grok",
          name: "Grok Build",
          capabilities: {
            reasoning: {
              label: "Reasoning",
              options: [{ value: "xhigh", label: "Extra high" }, { value: "high", label: "High" }],
            },
          },
          eligibleModels: [
            {
              serviceId: "xai",
              billingMode: "key",
              modelId: "grok-4.6",
              label: "Grok 4.6",
              serviceName: "xAI",
              canonicalModelKey: "grok-4.6",
            },
          ],
        },
      ]),
    );
    expect(keyOnly.harnesses[0].reasoningLevels).toEqual([]);

    const withSub = listSpawnParameters(
      registryWith([
        {
          id: "grok",
          name: "Grok Build",
          capabilities: {
            reasoning: {
              label: "Reasoning",
              options: [{ value: "xhigh", label: "Extra high" }, { value: "high", label: "High" }],
            },
          },
          eligibleModels: [
            {
              serviceId: "xai",
              billingMode: "sub",
              modelId: "grok-4.6",
              label: "Grok 4.6",
              serviceName: "xAI",
              canonicalModelKey: "grok-4.6",
            },
          ],
        },
      ]),
    );
    expect(withSub.harnesses[0].reasoningLevels).toEqual(["xhigh", "high"]);
  });

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
