import { afterEach, describe, expect, it, vi } from "vitest";
import type * as InstalledHarnesses from "../../shared/installed-harnesses.js";
import { agentAdmissionError, isAgentAuthenticated } from "./agent-auth-gate.js";

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
    return { refreshAuth: vi.fn(), get: vi.fn(() => ({ name: "Claude Code", installed, hasRunnableModels })) };
  }

  it("admits an installed, authenticated harness", () => {
    expect(agentAdmissionError(registry(true, true) as never, "claude")).toBeNull();
  });

  it("refuses a harness this deployment declared it does not install, before asking about auth", () => {
    uninstalledHarnesses.add("claude");
    const reg = registry(true, true);
    expect(agentAdmissionError(reg as never, "claude")).toMatch(/not installed in this deployment/);
    expect(reg.refreshAuth).not.toHaveBeenCalled();
  });

  it("admits on a bare $PATH miss — a probe is not the deployment saying no", () => {
    expect(agentAdmissionError(registry(true, false) as never, "claude")).toBeNull();
  });

  it("falls through to the auth message for an installed harness", () => {
    expect(agentAdmissionError(registry(false, true) as never, "claude")).toMatch(/not authenticated/);
  });
});
