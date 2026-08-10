import { afterEach, describe, expect, it, vi } from "vitest";
import type * as InstalledHarnesses from "../../shared/installed-harnesses.js";
import { agentAdmissionError, isAgentAuthenticated } from "./agent-auth-gate.js";

/**
 * docs/252 phase 9 — the harnesses this "deployment" declares it does NOT have.
 * Empty by default, which is the report-less case: nothing is declared, so
 * nothing is refused for not being installed.
 */
const uninstalledHarnesses = new Set<string>();
vi.mock("../../shared/installed-harnesses.js", async (importOriginal) => {
  const actual = await importOriginal<typeof InstalledHarnesses>();
  return { ...actual, isHarnessInstalled: (id: string) => !uninstalledHarnesses.has(id) };
});

afterEach(() => uninstalledHarnesses.clear());

describe("isAgentAuthenticated", () => {
  it("admits Claude when the account-aware registry finds a connected subscription", () => {
    let configured = false;
    const registry = {
      refreshAuth: vi.fn(() => { configured = true; }),
      get: vi.fn(() => ({ hasRunnableModels: configured })),
    };

    expect(isAgentAuthenticated(registry as never, "claude")).toBe(true);
    expect(registry.refreshAuth).toHaveBeenCalledWith("claude");
  });

  it("rejects the turn when no provider auth route is configured", () => {
    const registry = {
      refreshAuth: vi.fn(),
      get: vi.fn(() => ({ hasRunnableModels: false })),
    };

    expect(isAgentAuthenticated(registry as never, "claude")).toBe(false);
  });
});

describe("agentAdmissionError (docs/252 phase 9, req 14)", () => {
  function registry(hasRunnableModels: boolean, installed = false) {
    // `installed` here is the registry's own flag — a `which` probe wherever no
    // report exists. The gate must NOT read it; the tests below pin that.
    return { refreshAuth: vi.fn(), get: vi.fn(() => ({ name: "Claude Code", installed, hasRunnableModels })) };
  }

  it("admits an installed, authenticated harness", () => {
    expect(agentAdmissionError(registry(true, true) as never, "claude")).toBeNull();
  });

  it("refuses a harness this deployment declared it does not install, before asking about auth", () => {
    // This is the gate every effective-agent path passes through: a session
    // pinned before the harness was dropped, a stale browser selection, Quick
    // Capture, an inherited child agent. Without it they reach a missing binary.
    uninstalledHarnesses.add("claude");
    const reg = registry(true, true);
    expect(agentAdmissionError(reg as never, "claude")).toMatch(/not installed in this deployment/);
    // Not "sign in to Claude" — there is nothing here to sign into.
    expect(reg.refreshAuth).not.toHaveBeenCalled();
  });

  it("admits on a bare $PATH miss — a probe is not the deployment saying no", () => {
    // The regression this pins: refusing a turn on `AgentInfo.installed` broke
    // every environment with no install report (CI, a dev checkout, an injected
    // agent factory), where the flag is a `which` probe that can be wrong.
    expect(agentAdmissionError(registry(true, false) as never, "claude")).toBeNull();
  });

  it("falls through to the auth message for an installed harness", () => {
    expect(agentAdmissionError(registry(false, true) as never, "claude")).toMatch(/not authenticated/);
  });
});
