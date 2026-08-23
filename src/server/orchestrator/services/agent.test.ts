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
        get: () => ({ hasRunnableModels: true }),
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

describe("dispatchAgentMessage image admission (planning#460)", () => {
  /** The minimum deps a dispatch needs to reach the image checks. */
  function depsFor(session: Record<string, unknown>) {
    return {
      runnerRegistry: {
        get: () => ({
          disposed: false,
          agentId: "claude",
          sessionDir: "/tmp/session",
          running: false,
          assertCanDispatch: vi.fn(),
          dispatch: vi.fn(),
        }),
      },
      agentRegistry: { refreshAuth: vi.fn(), get: () => ({ hasRunnableModels: true }) },
      credentialStore: {},
      authManager: { authenticated: true, checkCredentials: vi.fn() },
      sessionManager: { get: () => session },
      graduation: {},
    };
  }
  const PNG = [{ data: "aGk=", mediaType: "image/png", filename: "shot.png" }];

  it("refuses an image dispatched at a session pinned to a text-only model", async () => {
    // The dispatched twin of the WS gate, covering the HTTP message route
    // (`api-routes-agent.ts`) — the one ingress that reaches a turn through this
    // service rather than through the composer. Ingresses that call
    // `runner.dispatch` DIRECTLY (Quick Capture) never come through here at all;
    // the backstop in `dispatched-turn.ts` is what covers those.
    const deps = depsFor({ warm: false, serviceId: "deepseek", billingMode: "key", model: "deepseek-v4-flash" });
    await expect(dispatchAgentMessage(deps as never, "session", { text: "what is this?", images: PNG }))
      .rejects.toThrow(/V4 Flash.*cannot read images/s);
  });

  it("dispatches the same image at a session pinned to a model that can see", async () => {
    const deps = depsFor({ warm: false, serviceId: "anthropic", billingMode: "sub", model: "claude-sonnet-5" });
    await expect(dispatchAgentMessage(deps as never, "session", { text: "what is this?", images: PNG }))
      .resolves.toEqual({ ok: true, queued: false });
  });
});
