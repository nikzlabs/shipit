import { describe, expect, it, vi } from "vitest";
import { agentAdmissionError, isAgentAuthenticated } from "./agent-auth-gate.js";

describe("isAgentAuthenticated", () => {
  it("admits Claude when the account-aware registry finds a connected subscription", () => {
    let configured = false;
    const registry = {
      refreshAuth: vi.fn(() => { configured = true; }),
      get: vi.fn(() => ({ authConfigured: configured })),
    };

    expect(isAgentAuthenticated(registry as never, "claude")).toBe(true);
    expect(registry.refreshAuth).toHaveBeenCalledWith("claude");
  });

  it("rejects the turn when no provider auth route is configured", () => {
    const registry = {
      refreshAuth: vi.fn(),
      get: vi.fn(() => ({ authConfigured: false })),
    };

    expect(isAgentAuthenticated(registry as never, "claude")).toBe(false);
  });
});

describe("agentAdmissionError (docs/252 phase 9, req 14)", () => {
  function registry(info: { installed: boolean; authConfigured: boolean }) {
    return { refreshAuth: vi.fn(), get: vi.fn(() => ({ name: "Claude Code", ...info })) };
  }

  it("admits an installed, authenticated harness", () => {
    expect(agentAdmissionError(registry({ installed: true, authConfigured: true }) as never, "claude"))
      .toBeNull();
  });

  it("refuses a harness this deployment did not install, before asking about auth", () => {
    // This is the gate every effective-agent path passes through: a session
    // pinned before the harness was dropped, a stale browser selection, Quick
    // Capture, an inherited child agent. Without it they reach a missing binary.
    const reg = registry({ installed: false, authConfigured: true });
    expect(agentAdmissionError(reg as never, "claude")).toMatch(/not installed in this deployment/);
    // Not "sign in to Claude" — there is nothing here to sign into.
    expect(reg.refreshAuth).not.toHaveBeenCalled();
  });

  it("falls through to the auth message for an installed harness", () => {
    expect(agentAdmissionError(registry({ installed: true, authConfigured: false }) as never, "claude"))
      .toMatch(/not authenticated/);
  });
});
