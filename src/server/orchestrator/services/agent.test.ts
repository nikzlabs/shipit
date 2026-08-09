import { describe, expect, it, vi } from "vitest";
import { dispatchAgentMessage } from "./agent.js";

describe("dispatchAgentMessage authentication", () => {
  it("admits a Claude provider account even when the legacy singleton auth manager is false", async () => {
    const dispatch = vi.fn();
    const refreshAuth = vi.fn();
    const runner = {
      disposed: false,
      agentId: "claude",
      sessionDir: "/tmp/session",
      running: false,
      assertCanDispatch: vi.fn(),
      dispatch,
    };
    const deps = {
      runnerRegistry: { get: () => runner },
      agentRegistry: {
        refreshAuth,
        get: () => ({ authConfigured: true }),
      },
      credentialStore: {},
      // Regression boundary: this is the obsolete value that rejected added
      // account rows before the account-aware AgentRegistry could route them.
      authManager: { authenticated: false, checkCredentials: vi.fn() },
      sessionManager: { get: () => ({ warm: false }) },
      graduation: {},
    };

    await expect(dispatchAgentMessage(deps as never, "session", { text: "continue" }))
      .resolves.toEqual({ ok: true, queued: false });
    expect(refreshAuth).toHaveBeenCalledWith("claude");
    expect(deps.authManager.checkCredentials).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
