import { describe, expect, it, vi } from "vitest";
import { isAgentAuthenticated } from "./agent-auth-gate.js";

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
