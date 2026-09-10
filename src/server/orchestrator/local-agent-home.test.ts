import { describe, it, expect, vi } from "vitest";
import { resolveLocalAgentHome } from "./local-agent-home.js";
import type { LocalAgentHomeDeps } from "./local-agent-home.js";
import type { SessionInfo } from "../shared/types.js";

const CREDENTIALS = "/credentials";

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return { id: "s1", ...overrides } as SessionInfo;
}

function deps(
  sessions: Record<string, SessionInfo>,
  providerAccountManager?: LocalAgentHomeDeps["providerAccountManager"],
  turnRoutes: Record<string, { kind: string; id: string } | undefined> = {},
): LocalAgentHomeDeps {
  return {
    sessionManager: { get: (id: string) => sessions[id] },
    credentialsDir: CREDENTIALS,
    getTurnRoute: (sessionId: string) => turnRoutes[sessionId],
    ...(providerAccountManager ? { providerAccountManager } : {}),
  };
}

describe("resolveLocalAgentHome (docs/260)", () => {
  it("resolves the account root of the turn's own route", () => {
    const home = resolveLocalAgentHome(
      "s1",
      "claude",
      deps(
        { s1: session({ agentId: "claude" }) },
        undefined,
        { s1: { kind: "account", id: "acct-a" } },
      ),
    );
    expect(home).toBe(`${CREDENTIALS}/provider-accounts/claude/acct-a`);
  });

  it("gives two sessions routed to different accounts different roots", () => {
    const d = deps(
      {
        s1: session({ id: "s1", agentId: "claude" }),
        s2: session({ id: "s2", agentId: "claude" }),
      },
      undefined,
      {
        s1: { kind: "account", id: "acct-a" },
        s2: { kind: "account", id: "acct-b" },
      },
    );
    expect(resolveLocalAgentHome("s1", "claude", d))
      .not.toBe(resolveLocalAgentHome("s2", "claude", d));
  });

  it("resolves a Codex turn's account root the same way", () => {
    const home = resolveLocalAgentHome(
      "s1",
      "codex",
      deps(
        { s1: session({ agentId: "codex" }) },
        undefined,
        { s1: { kind: "account", id: "acct-c" } },
      ),
    );
    expect(home).toBe(`${CREDENTIALS}/provider-accounts/codex/acct-c`);
  });

  it("keeps the process-global home for a reserved route", () => {
    const selectRouteForTurn = vi.fn().mockReturnValue({ kind: "account", id: "acct-a" });
    const home = resolveLocalAgentHome(
      "s1",
      "claude",
      deps(
        { s1: session({ agentId: "claude" }) },
        { selectRouteForTurn },
        { s1: { kind: "reserved", id: "claude-api-key" } },
      ),
    );
    expect(home).toBeUndefined();
    expect(selectRouteForTurn).not.toHaveBeenCalled();
  });

  it("returns undefined for an unknown session with no account manager", () => {
    expect(resolveLocalAgentHome("missing", "claude", deps({}))).toBeUndefined();
  });

  it("selects the other provider's account for a cross-provider spawn", () => {
    const selectRouteForTurn = vi.fn((serviceId: string) =>
      serviceId === "openai" ? { kind: "account" as const, id: "acct-codex" } : null);
    const home = resolveLocalAgentHome(
      "s1",
      "codex",
      deps(
        { s1: session({ agentId: "claude", providerRouteKind: "account", providerRouteId: "acct-a" }) },
        { selectRouteForTurn },
      ),
    );
    expect(home).toBe(`${CREDENTIALS}/provider-accounts/codex/acct-codex`);
    expect(selectRouteForTurn).toHaveBeenCalledWith("openai");
  });

  it("falls back to the provider's selection for a session not pinned yet", () => {
    const selectRouteForTurn = vi.fn().mockReturnValue({ kind: "account", id: "acct-a" });
    const home = resolveLocalAgentHome(
      "s1",
      "claude",
      deps({ s1: session({}) }, { selectRouteForTurn }),
    );
    expect(home).toBe(`${CREDENTIALS}/provider-accounts/claude/acct-a`);
  });

  it("returns undefined when the provider's selection is a reserved route", () => {
    const selectRouteForTurn = vi.fn().mockReturnValue({ kind: "reserved", id: "codex-api-key" });
    expect(resolveLocalAgentHome(
      "s1",
      "codex",
      deps({ s1: session({ agentId: "claude" }) }, { selectRouteForTurn }),
    )).toBeUndefined();
  });
});
