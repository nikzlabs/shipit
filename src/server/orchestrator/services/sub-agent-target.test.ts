import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentRole, CredentialRoute, ReviewerPin, ReviewerSlot } from "../../shared/types.js";
import { ServiceError } from "./types.js";

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

const REVIEWER_ROLE: AgentRole = { name: "reviewer", params: { kind: "auto" } };

function storeWith(
  routes: CredentialRoute[],
  pins: Partial<Record<ReviewerSlot, ReviewerPin>> = {},
  roles: AgentRole[] = [],
) {
  const all = [...roles, REVIEWER_ROLE];
  return {
    getReviewerPin: (slot: ReviewerSlot) => pins[slot],
    getRoles: () => all,
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

const OPENAI_KEY = route("openai", "key");
const ANTHROPIC_KEY = route("anthropic", "key");
const DEEPSEEK_KEY = route("deepseek", "key");

const FULL = {
  agentId: "codex",
  serviceId: "openai",
  billingMode: "sub",
  modelId: "gpt-5.6-sol",
  reasoningEffort: "high",
};

describe("parseSubAgentSpawnTarget — the explicit path (docs/261 req 7)", () => {
  it("accepts a call that names every parameter", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget(FULL)).toEqual({
      kind: "explicit",
      harnessId: "codex",
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });

  for (const field of ["agentId", "serviceId", "billingMode", "modelId", "reasoningEffort"]) {
    it(`refuses a call missing ${field} rather than filling it in`, async () => {
      const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
      const body: Record<string, unknown> = Object.fromEntries(
        Object.entries(FULL).filter(([key]) => key !== field),
      );
      expect(() => parseSubAgentSpawnTarget(body)).toThrow(ServiceError);
      try {
        parseSubAgentSpawnTarget(body);
      } catch (err) {
        expect((err as ServiceError).statusCode).toBe(400);
        expect((err as ServiceError).message).toContain("missing");
      }
    });
  }

  it("names every missing flag at once, so one round trip fixes the call", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    try {
      parseSubAgentSpawnTarget({ agentId: "codex" });
      throw new Error("expected a refusal");
    } catch (err) {
      const message = (err as ServiceError).message;
      for (const flag of ["--service", "--billing-mode", "--model", "--effort"]) {
        expect(message).toContain(flag);
      }
      expect(message).not.toContain("--agent,");
    }
  });

  it("treats a blank string as absent — a quoted empty flag is not an answer", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() => parseSubAgentSpawnTarget({ ...FULL, reasoningEffort: "  " })).toThrow(ServiceError);
  });

  it("refuses a billing mode that is neither sub nor key", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() => parseSubAgentSpawnTarget({ ...FULL, billingMode: "free" })).toThrow(/sub/);
  });
});

describe("parseSpawnTarget — a harness with no reasoning levels (docs/275)", () => {
  const GROK_FULL = {
    agentId: "grok",
    serviceId: "xai",
    billingMode: "key",
    modelId: "grok-4.6",
  };

  it("accepts the four identity flags as a complete call (req 2)", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget(GROK_FULL)).toEqual({
      kind: "explicit",
      harnessId: "grok",
      serviceId: "xai",
      billingMode: "key",
      modelId: "grok-4.6",
    });
  });

  it("still refuses an incomplete call, without asking for --effort (req 4)", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const body: Record<string, unknown> = { ...GROK_FULL };
    delete body.modelId;
    try {
      parseSubAgentSpawnTarget(body);
      throw new Error("expected a refusal");
    } catch (err) {
      const message = (err as ServiceError).message;
      expect(message).toContain("--model");
      expect(message).not.toContain("--effort");
    }
  });

  it("refuses a blank --effort as an empty value rather than reading it as absence (req 3)", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() => parseSubAgentSpawnTarget({ ...GROK_FULL, reasoningEffort: "  " })).toThrow(
      /--effort was given an empty value/,
    );
  });

  it("lets a named effort ride through to resolution, which owns the refusal", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget({ ...GROK_FULL, reasoningEffort: "high" })).toEqual({
      kind: "explicit",
      harnessId: "grok",
      serviceId: "xai",
      billingMode: "key",
      modelId: "grok-4.6",
      reasoningEffort: "high",
    });
  });

  it("reads the complete four-flag call as explicit even over a parent (req 5)", async () => {
    const { parseSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSpawnTarget(GROK_FULL, { parentBase: true })).toEqual({
      kind: "explicit",
      harnessId: "grok",
      serviceId: "xai",
      billingMode: "key",
      modelId: "grok-4.6",
    });
  });

  it("keeps the conservative five-flag message when no harness is named at all", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    try {
      parseSubAgentSpawnTarget({ serviceId: "xai" });
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as ServiceError).message).toContain("--effort");
    }
  });
});

describe("parseSpawnTarget — the role path with overrides (docs/264-agent-roles reqs 10, 13, 18)", () => {
  it("accepts a role on its own, with nothing overridden", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget({ role: "reviewer" })).toEqual({
      kind: "role",
      role: "reviewer",
      overrides: {},
    });
  });

  for (const [field, key, value] of [
    ["agentId", "harnessId", "codex"],
    ["serviceId", "serviceId", "openai"],
    ["billingMode", "billingMode", "key"],
    ["modelId", "modelId", "gpt-5.6-sol"],
    ["reasoningEffort", "reasoningEffort", "high"],
  ] as const) {
    it(`carries a role plus ${field} as an override rather than refusing it`, async () => {
      const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
      expect(parseSubAgentSpawnTarget({ role: "deep-dive", [field]: value })).toEqual({
        kind: "role",
        role: "deep-dive",
        overrides: { [key]: value },
      });
    });
  }

  it("passes an unknown role name through rather than rejecting it locally", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget({ role: "deep dive, please" })).toEqual({
      kind: "role",
      role: "deep dive, please",
      overrides: {},
    });
  });

  for (const [field, flag] of [
    ["agentId", "--agent"],
    ["serviceId", "--service"],
    ["modelId", "--model"],
    ["reasoningEffort", "--effort"],
  ] as const) {
    it(`refuses a role whose ${flag} override is present but empty`, async () => {
      const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
      expect(() => parseSubAgentSpawnTarget({ role: "reviewer", [field]: "   " })).toThrow(
        new RegExp(flag),
      );
      expect(() => parseSubAgentSpawnTarget({ role: "reviewer", [field]: 42 })).toThrow(
        new RegExp(flag),
      );
    });
  }

  it("passes a role name through exactly as typed, spaces included (req 18)", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    for (const name of [" reviewer ", " deep dive ", "deep dive "]) {
      expect(parseSubAgentSpawnTarget({ role: name })).toEqual({
        kind: "role",
        role: name,
        overrides: {},
      });
    }
  });

  it("refuses a --role that is present but empty rather than reading it as absent", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    for (const value of ["", "   ", 42]) {
      expect(() => parseSubAgentSpawnTarget({ role: value })).toThrow(
        /--role was given an empty value/,
      );
    }
  });

  it("reads an explicit null as absence, unlike a blank string", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSubAgentSpawnTarget({ role: "reviewer", modelId: null, agentId: null })).toEqual({
      kind: "role",
      role: "reviewer",
      overrides: {},
    });
  });

  it("still refuses a billing mode that is neither sub nor key, even as an override", async () => {
    const { parseSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() => parseSubAgentSpawnTarget({ role: "reviewer", billingMode: "free" })).toThrow(/sub/);
  });
});

describe("parseSpawnTarget — the parent base (req 16)", () => {
  it("accepts a partial call when a parent is available, and refuses it when not", async () => {
    const { parseSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSpawnTarget({ modelId: "gpt-5.6-sol" }, { parentBase: true })).toEqual({
      kind: "inherit",
      overrides: { modelId: "gpt-5.6-sol" },
    });
    expect(() => parseSpawnTarget({ modelId: "gpt-5.6-sol" }, { parentBase: false })).toThrow(
      /missing/,
    );
  });

  it("reads an empty call over a parent as inheriting everything", async () => {
    const { parseSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSpawnTarget({}, { parentBase: true })).toEqual({ kind: "inherit", overrides: {} });
  });

  it("reads a complete call as explicit even where a parent exists", async () => {
    const { parseSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSpawnTarget(FULL, { parentBase: true })).toEqual({
      kind: "explicit",
      harnessId: "codex",
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });

  it("prefers a role over the parent when both could apply", async () => {
    const { parseSpawnTarget } = await import("./sub-agent-target.js");
    expect(parseSpawnTarget({ role: "deep-dive", modelId: "x" }, { parentBase: true })).toEqual({
      kind: "role",
      role: "deep-dive",
      overrides: { modelId: "x" },
    });
  });

  describe("--no-role (docs/264-agent-roles req 20)", () => {
    it("carries the decline onto the inherit target, overrides and all", async () => {
      const { parseSpawnTarget } = await import("./sub-agent-target.js");
      expect(parseSpawnTarget({ noRole: true, modelId: "gpt-5.6-sol" }, { parentBase: true })).toEqual({
        kind: "inherit",
        overrides: { modelId: "gpt-5.6-sol" },
        noRole: true,
      });
    });

    it("leaves the flag off the target when it was not asked for", async () => {
      const { parseSpawnTarget } = await import("./sub-agent-target.js");
      expect(parseSpawnTarget({}, { parentBase: true })).toEqual({ kind: "inherit", overrides: {} });
    });

    it("refuses --no-role together with --role rather than picking one", async () => {
      const { parseSpawnTarget } = await import("./sub-agent-target.js");
      expect(() =>
        parseSpawnTarget({ role: "deep-dive", noRole: true }, { parentBase: true }),
      ).toThrow(/opposite things/);
    });

    it("refuses --no-role where there is no parent to inherit a role from", async () => {
      const { parseSpawnTarget } = await import("./sub-agent-target.js");
      expect(() => parseSpawnTarget({ ...FULL, noRole: true }, { parentBase: false })).toThrow(
        /one-shot run has no/,
      );
    });
  });
});

describe("resolveSpawnTarget", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../shared/installed-harnesses.js");
  });

  const installAll = () =>
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));

  it("takes an explicit call literally — no route, no derivation", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const resolved = resolveSubAgentSpawnTarget(
      {
        kind: "explicit",
        harnessId: "codex",
        serviceId: "openai",
        billingMode: "sub",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
      { harnessId: "claude" },
      { credentialStore: storeWith([]) },
    );
    expect(resolved.selection).toEqual({
      serviceId: "openai",
      billingMode: "sub",
      modelId: "gpt-5.6-sol",
    });
    expect(resolved.reasoningEffort).toBe("high");
    expect(resolved.route).toBeUndefined();
    expect(resolved.reviewer).toBeUndefined();
    expect(resolved.roleName).toBeUndefined();
  });

  it("refuses a triple the catalogue does not carry", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        {
          kind: "explicit",
          harnessId: "codex",
          serviceId: "openai",
          billingMode: "sub",
          modelId: "gpt-9-imaginary",
          reasoningEffort: "high",
        },
        { harnessId: "claude" },
        { credentialStore: storeWith([]) },
      ),
    ).toThrow(/gpt-9-imaginary/);
  });

  it("refuses a harness pointed at a model it shares no API style with", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        {
          kind: "explicit",
          harnessId: "claude",
          serviceId: "openai",
          billingMode: "sub",
          modelId: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
        { harnessId: "claude" },
        { credentialStore: storeWith([]) },
      ),
    ).toThrow(/cannot run/);
  });

  it("refuses an effort the named harness does not offer", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        {
          kind: "explicit",
          harnessId: "codex",
          serviceId: "openai",
          billingMode: "sub",
          modelId: "gpt-5.6-sol",
          reasoningEffort: "ludicrous",
        },
        { harnessId: "claude" },
        { credentialStore: storeWith([]) },
      ),
    ).toThrow(/ludicrous/);
  });

  it("resolves a complete target on a harness that declares no levels (docs/275)", async () => {
    const { parseSubAgentSpawnTarget, resolveSubAgentSpawnTarget } = await import(
      "./sub-agent-target.js"
    );
    const resolved = resolveSubAgentSpawnTarget(
      parseSubAgentSpawnTarget({
        agentId: "grok",
        serviceId: "xai",
        billingMode: "key",
        modelId: "grok-4.6",
      }),
      { harnessId: "claude" },
      { credentialStore: storeWith([]) },
    );
    expect(resolved.harnessId).toBe("grok");
    expect(resolved.selection).toEqual({
      serviceId: "xai",
      billingMode: "key",
      modelId: "grok-4.6",
    });
    expect("reasoningEffort" in resolved).toBe(false);
  });

  it("refuses an effort named on a harness that declares no levels (docs/275)", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        {
          kind: "explicit",
          harnessId: "grok",
          serviceId: "xai",
          billingMode: "key",
          modelId: "grok-4.6",
          reasoningEffort: "high",
        },
        { harnessId: "claude" },
        { credentialStore: storeWith([]) },
      ),
    ).toThrow(/offers no reasoning levels/);
  });

  it("refuses an omitted effort on a harness that declares levels (docs/275)", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        {
          kind: "explicit",
          harnessId: "codex",
          serviceId: "openai",
          billingMode: "sub",
          modelId: "gpt-5.6-sol",
        },
        { harnessId: "claude" },
        { credentialStore: storeWith([]) },
      ),
    ).toThrow(/must name --effort/);
  });

  it("refuses an unknown harness by name (docs/275)", async () => {
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        {
          kind: "explicit",
          harnessId: "grokk" as never,
          serviceId: "xai",
          billingMode: "key",
          modelId: "grok-4.6",
        },
        { harnessId: "claude" },
        { credentialStore: storeWith([]) },
      ),
    ).toThrow(/Unknown agent: grokk/);
  });

  it("refuses an --effort override on a role pinned to a no-levels harness (docs/275)", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const XAI_KEY = route("xai", "key");
    const grokRole = {
      name: "grok-hand",
      params: {
        kind: "pinned" as const,
        harnessId: "grok" as never,
        serviceId: "xai",
        billingMode: "key" as const,
        modelId: "grok-4.6",
      },
    };
    const bare = resolveSubAgentSpawnTarget(
      { kind: "role", role: "grok-hand", overrides: {} },
      { harnessId: "claude" },
      { credentialStore: storeWith([XAI_KEY], {}, [grokRole]), env: {} },
    );
    expect(bare.harnessId).toBe("grok");
    expect("reasoningEffort" in bare).toBe(false);
    expect(() =>
      resolveSubAgentSpawnTarget(
        { kind: "role", role: "grok-hand", overrides: { reasoningEffort: "high" } },
        { harnessId: "claude" },
        { credentialStore: storeWith([XAI_KEY], {}, [grokRole]), env: {} },
      ),
    ).toThrow(/no reasoning levels/);
  });

  it("resolves a role to the reviewer furthest from the implementer", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const resolved = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer", overrides: {} },
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([OPENAI_KEY, ANTHROPIC_KEY]), env: {} },
    );
    expect(resolved.harnessId).toBe("codex");
    expect(resolved.selection.serviceId).toBe("openai");
    expect(resolved.reasoningEffort).toBeTruthy();
    expect(resolved.route).toBeDefined();
    expect(resolved.reviewer?.tier).toBe(1);
    expect(resolved.reviewer?.tierBasis).toBe("model-and-harness");
    expect(resolved.roleName).toBe("reviewer");
  });

  it("picks a different reviewer for a different implementer, with nothing reconfigured", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const deps = { credentialStore: storeWith([OPENAI_KEY, DEEPSEEK_KEY]), env: {} };
    const forClaude = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer", overrides: {} },
      { harnessId: "claude", selection: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4" } },
      deps,
    );
    const forCodex = resolveSubAgentSpawnTarget(
      { kind: "role", role: "reviewer", overrides: {} },
      { harnessId: "codex", selection: { serviceId: "openai", billingMode: "key", modelId: "gpt-5.6-sol" } },
      deps,
    );
    expect(forClaude.harnessId).toBe("codex");
    expect(forCodex.harnessId).toBe("claude");
  });

  it("refuses a role when no reviewer has a usable credential", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        { kind: "role", role: "reviewer", overrides: {} },
        { harnessId: "claude" },
        { credentialStore: storeWith([]), env: {} },
      ),
    ).toThrow(/cannot run/);
  });

  it("runs the role whose name matches exactly, not the reserved one it resembles", async () => {
    installAll();
    const { parseSubAgentSpawnTarget, resolveSubAgentSpawnTarget } = await import(
      "./sub-agent-target.js"
    );
    const spaced: AgentRole = {
      name: " reviewer ",
      params: {
        kind: "pinned",
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
        reasoningEffort: "high",
      },
    };
    const resolved = resolveSubAgentSpawnTarget(
      parseSubAgentSpawnTarget({ role: " reviewer " }),
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([OPENAI_KEY, ANTHROPIC_KEY], {}, [spaced]), env: {} },
    );
    expect(resolved.roleName).toBe(" reviewer ");
    expect(resolved.harnessId).toBe("claude");
    expect(resolved.selection.modelId).toBe("claude-opus-5");
    expect(resolved.reviewer).toBeUndefined();
  });

  it("refuses an unknown role, naming the roles that exist", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    expect(() =>
      resolveSubAgentSpawnTarget(
        { kind: "role", role: "critic", overrides: {} },
        { harnessId: "claude" },
        { credentialStore: storeWith([OPENAI_KEY]), env: {} },
      ),
    ).toThrow(/critic.*reviewer/s);
  });

  it("applies an override over a role, landing where the caller asked", async () => {
    installAll();
    const { resolveSubAgentSpawnTarget } = await import("./sub-agent-target.js");
    const resolved = resolveSubAgentSpawnTarget(
      {
        kind: "role",
        role: "reviewer",
        overrides: { harnessId: "claude", modelId: "claude-opus-5" },
      },
      {
        harnessId: "claude",
        selection: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([OPENAI_KEY, ANTHROPIC_KEY]), env: {} },
    );
    expect(resolved.harnessId).toBe("claude");
    expect(resolved.selection.modelId).toBe("claude-opus-5");
    expect(resolved.reasoningEffort).toBeTruthy();
    expect(resolved.roleName).toBe("reviewer");
  });
});

describe("resolveSpawnTargetForChild (req 11)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../shared/installed-harnesses.js");
  });

  it("drops the frozen route and the ranking, keeping the tuple and the role name", async () => {
    vi.doMock("../../shared/installed-harnesses.js", () => ({
      isHarnessInstalled: () => true,
      readInstalledHarnesses: () => ["claude", "codex"],
    }));
    const { resolveSubAgentSpawnTarget, resolveSpawnTargetForChild } = await import("./sub-agent-target.js");
    const args = [
      { kind: "role" as const, role: "reviewer", overrides: {} },
      {
        harnessId: "claude" as const,
        selection: { serviceId: "anthropic", billingMode: "key" as const, modelId: "claude-opus-5" },
      },
      { credentialStore: storeWith([OPENAI_KEY, ANTHROPIC_KEY]), env: {} },
    ] as const;

    const oneShot = resolveSubAgentSpawnTarget(...args);
    const child = resolveSpawnTargetForChild(...args);

    expect(oneShot.route).toBeDefined();
    expect(child.route).toBeUndefined();
    expect(child.reviewer).toBeUndefined();
    expect(child.harnessId).toBe(oneShot.harnessId);
    expect(child.selection).toEqual(oneShot.selection);
    expect(child.reasoningEffort).toBe(oneShot.reasoningEffort);
    expect(child.roleName).toBe("reviewer");
  });
});

describe("assertHarnessCanRunSelection", () => {
  const selection = { serviceId: "openai", billingMode: "sub" as const, modelId: "gpt-5.6-sol" };

  it("accepts a selection in the harness's eligible set", async () => {
    const { assertHarnessCanRunSelection } = await import("./sub-agent-target.js");
    expect(() => assertHarnessCanRunSelection("Codex", [selection], selection)).not.toThrow();
  });

  it("refuses a harness pointed at a model no credential of its own offers", async () => {
    const { assertHarnessCanRunSelection } = await import("./sub-agent-target.js");
    expect(() =>
      assertHarnessCanRunSelection("Claude Code", [selection], { ...selection, modelId: "gpt-5.6-luna" }),
    ).toThrow(/cannot run/);
  });

  it("skips the check when the registry reports no eligible set at all", async () => {
    const { assertHarnessCanRunSelection } = await import("./sub-agent-target.js");
    expect(() => assertHarnessCanRunSelection("codex", [], selection)).not.toThrow();
    expect(() => assertHarnessCanRunSelection("codex", undefined, selection)).not.toThrow();
  });
});
