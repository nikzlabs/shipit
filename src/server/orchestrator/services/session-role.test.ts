import { describe, it, expect, vi } from "vitest";
import type { AgentRole, CredentialRoute, ReviewerSlot, SessionInfo } from "../../shared/types.js";

/**
 * docs/272-user-selectable-roles — the three moments a user-started role has: resolving it,
 * applying it, and delivering its standing instructions once.
 *
 * Driven against the **real catalogue**, for the reason `roles.test.ts` states:
 * these are claims about which harness carries which model and which levels it
 * declares, and a fabricated catalogue would let a wrong claim pass. `env: {}`
 * everywhere, so a deployment-supplied key on the test host cannot add a
 * credential the fixture never configured.
 */

const EMPTY_ENV: NodeJS.ProcessEnv = {};

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

const DEEPSEEK_KEY = route("deepseek", "key");

function storeWith(roles: AgentRole[], routes: CredentialRoute[] = [DEEPSEEK_KEY]) {
  return {
    getReviewerPin: vi.fn((_slot: ReviewerSlot) => undefined),
    getRoles: () => roles,
    getRole: (name: string) => roles.find((r) => r.name === name),
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

const ALL_INSTALLED = () => true;

const DEEP_DIVE: AgentRole = {
  name: "deep dive",
  description: "Long-form investigation",
  prompt: "Read the whole subsystem before proposing anything.",
  params: {
    kind: "pinned",
    harnessId: "claude",
    serviceId: "deepseek",
    billingMode: "key",
    modelId: "deepseek-v4-flash",
    reasoningEffort: "high",
  },
};

const REVIEWER: AgentRole = { name: "reviewer", params: { kind: "auto" } };

function deps(roles: AgentRole[], routes?: CredentialRoute[]) {
  return { credentialStore: storeWith(roles, routes), env: EMPTY_ENV, isInstalled: ALL_INSTALLED };
}

// ---- Which roles a user may start (reqs 10, 16) -----------------------------

describe("listUserSelectableRoles / hasUserSelectableRole", () => {
  it("never offers the reviewer (req 10)", async () => {
    const { listUserSelectableRoles } = await import("./session-role.js");
    const names = listUserSelectableRoles(deps([REVIEWER, DEEP_DIVE])).map((r) => r.name);
    expect(names).toEqual(["deep dive"]);
  });

  it("does not count the reviewer towards 'the user has a role' (req 16)", async () => {
    const { hasUserSelectableRole } = await import("./session-role.js");
    // The rule dies on arrival if this is true: the reviewer is on every install.
    expect(hasUserSelectableRole(deps([REVIEWER]))).toBe(false);
    expect(hasUserSelectableRole(deps([REVIEWER, DEEP_DIVE]))).toBe(true);
  });
});

// ---- Refusals (reqs 8, 9, 10) ----------------------------------------------

describe("resolveUserRole refuses rather than substituting (req 8)", () => {
  it("refuses an unknown name and lists the roles that exist", async () => {
    const { resolveUserRole } = await import("./session-role.js");
    expect(() => resolveUserRole("deap dive", deps([DEEP_DIVE]))).toThrow(/deep dive/);
  });

  it("says so plainly when there are no roles at all", async () => {
    const { resolveUserRole } = await import("./session-role.js");
    expect(() => resolveUserRole("anything", deps([REVIEWER]))).toThrow(/No roles are configured/);
  });

  it("refuses the reviewer, naming why it only means something to an agent (req 10)", async () => {
    const { resolveUserRole } = await import("./session-role.js");
    expect(() => resolveUserRole("reviewer", deps([REVIEWER, DEEP_DIVE]))).toThrow(
      /furthest from whatever produced the work/,
    );
  });

  it("refuses a stranded role and sends the user to Settings, not to the service (req 9)", async () => {
    const { resolveUserRole } = await import("./session-role.js");
    const stranded: AgentRole = {
      ...DEEP_DIVE,
      params: { ...DEEP_DIVE.params, modelId: "a-model-that-left" } as AgentRole["params"],
    };
    expect(() => resolveUserRole("deep dive", deps([stranded]))).toThrow(/Settings → Roles/);
  });

  it("refuses a disconnected role by pointing at the SERVICE, because the role is correct (req 9)", async () => {
    const { resolveUserRole } = await import("./session-role.js");
    // The tuple is intact; this install simply holds no credential for it.
    expect(() => resolveUserRole("deep dive", deps([DEEP_DIVE], []))).toThrow(
      /Reconnect the service/,
    );
  });

  it("returns the role's own tuple when it can run", async () => {
    const { resolveUserRole } = await import("./session-role.js");
    const resolved = resolveUserRole("deep dive", deps([DEEP_DIVE]));
    expect(resolved.params).toMatchObject({
      harnessId: "claude",
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "high",
    });
  });
});

// ---- Applying it (req 3) ----------------------------------------------------

describe("applyRoleToSession writes the ORDINARY fields (req 3)", () => {
  it("seeds harness, selection and level, and records the role last", async () => {
    const { applyRoleToSession, resolveUserRole } = await import("./session-role.js");
    const calls: string[] = [];
    const sessionManager = {
      setAgentId: vi.fn(() => calls.push("agent")),
      setModelSelection: vi.fn(() => calls.push("selection")),
      setReasoning: vi.fn(() => calls.push("reasoning")),
      setRoleName: vi.fn(() => calls.push("role")),
    };
    applyRoleToSession("s1", resolveUserRole("deep dive", deps([DEEP_DIVE])), {
      sessionManager: sessionManager as never,
    });
    expect(sessionManager.setAgentId).toHaveBeenCalledWith("s1", "claude");
    expect(sessionManager.setModelSelection).toHaveBeenCalledWith("s1", {
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4-flash",
    });
    expect(sessionManager.setReasoning).toHaveBeenCalledWith("s1", "high");
    expect(sessionManager.setRoleName).toHaveBeenCalledWith("s1", "deep dive");
    // The name goes last: the three writes before it are the same ones a user
    // moving a control makes, and those clear the role at their own call sites.
    expect(calls[calls.length - 1]).toBe("role");
  });
});

// ---- The standing instructions, once (req 2) --------------------------------

describe("takeRoleStandingInstructions is a one-shot latched on originRoleName (req 2)", () => {
  function instructionDeps(session: Partial<SessionInfo>, role: AgentRole | undefined = DEEP_DIVE) {
    const row = { id: "s1", ...session } as SessionInfo;
    const setOriginRoleName = vi.fn((_id: string, name: string) => {
      row.originRoleName = name;
    });
    return {
      row,
      setOriginRoleName,
      deps: {
        sessionManager: { get: () => row, setOriginRoleName } as never,
        credentialStore: { getRole: () => role } as never,
      },
    };
  }

  it("delivers the block on the first turn and writes the provenance (req 6)", async () => {
    const { takeRoleStandingInstructions } = await import("./session-role.js");
    const f = instructionDeps({ roleName: "deep dive" });
    const block = takeRoleStandingInstructions("s1", f.deps);
    expect(block).toContain("Read the whole subsystem");
    expect(block).toContain('role="deep dive"');
    expect(f.setOriginRoleName).toHaveBeenCalledWith("s1", "deep dive");
  });

  it("delivers nothing on the second call, because the latch has closed", async () => {
    const { takeRoleStandingInstructions } = await import("./session-role.js");
    const f = instructionDeps({ roleName: "deep dive" });
    takeRoleStandingInstructions("s1", f.deps);
    expect(takeRoleStandingInstructions("s1", f.deps)).toBe("");
  });

  it("closes the latch even for a role with no standing instructions", async () => {
    const { takeRoleStandingInstructions } = await import("./session-role.js");
    // Otherwise a prompt-less role re-asks this question on every turn forever.
    const promptless: AgentRole = { name: "deep dive", params: DEEP_DIVE.params };
    const f = instructionDeps({ roleName: "deep dive" }, promptless);
    expect(takeRoleStandingInstructions("s1", f.deps)).toBe("");
    expect(f.setOriginRoleName).toHaveBeenCalledWith("s1", "deep dive");
  });

  it("skips an agent-spawned child, whose prompt was already joined at creation", async () => {
    const { takeRoleStandingInstructions } = await import("./session-role.js");
    const f = instructionDeps({ roleName: "deep dive", originRoleName: "deep dive" });
    expect(takeRoleStandingInstructions("s1", f.deps)).toBe("");
    expect(f.setOriginRoleName).not.toHaveBeenCalled();
  });

  it("does nothing at all for a session with no role in force", async () => {
    const { takeRoleStandingInstructions } = await import("./session-role.js");
    const f = instructionDeps({});
    expect(takeRoleStandingInstructions("s1", f.deps)).toBe("");
    expect(f.setOriginRoleName).not.toHaveBeenCalled();
  });
});

// ---- A retired model is a role that needs editing, not one to re-point ------

describe("a retired model strands the role rather than following its successor", () => {
  it("refuses it and sends the user to Settings (req 8, docs/264 req 7)", async () => {
    const { resolveUserRole } = await import("./session-role.js");
    // `gpt-5.6` lives in its mode's `retired[]` and NOT in its model list, so
    // `selectionExists` is already false for it — which is what makes the
    // refusal automatic rather than a rule this module has to restate.
    //
    // This matters beyond the message: without it, a browser seed naming such a
    // role would re-apply the retired model on every page load, immediately
    // after the connect handler had just moved the session onto the successor —
    // an oscillation cross-agent review predicted. The refusal is what stops it,
    // so it is pinned here rather than left to be inferred from the catalogue.
    const retired: AgentRole = {
      name: "legacy",
      params: {
        kind: "pinned",
        harnessId: "codex",
        serviceId: "openai",
        billingMode: "sub",
        modelId: "gpt-5.6",
        reasoningEffort: "high",
      },
    };
    expect(() => resolveUserRole("legacy", deps([retired], [route("openai", "sub")]))).toThrow(
      /Settings → Roles/,
    );
  });
});
