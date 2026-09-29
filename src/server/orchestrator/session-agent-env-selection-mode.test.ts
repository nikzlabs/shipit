import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { CredentialStore } from "./credential-store.js";
import type { SessionManager } from "./sessions.js";
import { prepareSessionAgentEnvironment } from "./session-agent-env.js";
import { perSessionCredentialsDir } from "./session-credentials-scaffold.js";
import { writeSessionResidentRoute } from "./session-credentials.js";

class FakeRunner extends EventEmitter {
  agentId = "claude" as const;
  running = false;
  disposed = false;
  sessionId = "s1";
  sessionDir = "/tmp/s1";
  pushAgentEnv = vi.fn();
}

function makeCredentialStore(): CredentialStore {
  return {
    getProviderAccount: () => undefined,
    listProviderAccounts: () => [],
    getAgentEnv: () => undefined,
    getAllAgentEnv: () => ({}),
    listCredentialRoutes: () => [],
    getCredentialSecret: () => undefined,
    getCredentialRoute: () => undefined,
    markCredentialRouteUsed: () => {},
    getSelectionMode: () => "strict" as const,
  } as unknown as CredentialStore;
}

function makeSessionManager(opts: {
  agentPinned: boolean;
  providerRouteKind?: "account" | "reserved";
  providerRouteId?: string;
}) {
  const setProviderRouteCalls: { kind: string; routeId: string }[] = [];
  const session = {
    id: "s1",
    agentPinned: opts.agentPinned,
    providerRouteKind: opts.providerRouteKind,
    providerRouteId: opts.providerRouteId,
    workspaceDir: "/tmp/s1",
  };
  const sm = {
    get: () => session,
    setAgentId: () => {},
    setAgentPinned: () => { session.agentPinned = true; },
    setProviderRoute: (_id: string, kind: string, routeId: string) => {
      setProviderRouteCalls.push({ kind, routeId });
    },
    setAgentSessionId: () => {},
    clearAgentSessionId: () => {},
  } as unknown as SessionManager;
  return { sm, setProviderRouteCalls };
}

describe("account selection mode at turn time (docs/260-turn-level-account-routing reqs 1, 8 + docs/150-multiple-provider-subscriptions req 21)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-selection-pin-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function routeTurn(
    mode: "strict" | "balanced",
    turn: { residentRoute?: { kind: "account"; id: string }; previousRouteId?: string } = {},
  ) {
    const accounts = [
      { id: "acct-first", lastUsedAt: 9_000 },
      { id: "acct-second", lastUsedAt: 1 },
    ];
    const selectAccountForTurn = vi.fn(() => {
      const ordered =
        mode === "balanced"
          ? [...accounts].sort((a, b) => a.lastUsedAt - b.lastUsedAt)
          : accounts;
      return { ok: true as const, route: { kind: "account" as const, id: ordered[0]!.id } };
    });
    const markAccountUsed = vi.fn();
    const { sm, setProviderRouteCalls } = makeSessionManager({ agentPinned: false });

    const result = await prepareSessionAgentEnvironment(
      new FakeRunner() as unknown as SessionRunnerInterface,
      {
        sessionId: "s1",
        agentId: "claude",
        enforceAccountRouting: true,
        ...turn,
        deps: {
          credentialsDir: tmpDir,
          credentialStore: makeCredentialStore(),
          sessionManager: sm,
          providerAccountManager: { selectAccountForTurn, markAccountUsed } as never,
        },
      },
    );
    return { setProviderRouteCalls, markAccountUsed, selectAccountForTurn, turnRoute: result.turnRoute };
  }

  it("gives the router the previous turn's account as current when the process ended (req 8)", async () => {
    const { selectAccountForTurn } = await routeTurn("balanced", { previousRouteId: "acct-first" });
    expect(selectAccountForTurn).toHaveBeenCalledWith(
      "anthropic",
      expect.objectContaining({ currentRouteId: "acct-first" }),
    );
  });

  it("prefers the last spawn's record, which also covers a turn that died before its result (req 8)", async () => {
    fs.mkdirSync(perSessionCredentialsDir(tmpDir, "s1"), { recursive: true });
    writeSessionResidentRoute(tmpDir, "s1", "claude", { kind: "account", id: "acct-second" });

    const { selectAccountForTurn } = await routeTurn("balanced", { previousRouteId: "acct-first" });
    expect(selectAccountForTurn).toHaveBeenCalledWith(
      "anthropic",
      expect.objectContaining({ currentRouteId: "acct-second" }),
    );
  });

  it("a live process's account is the session's account, over the previous turn's (req 8)", async () => {
    const { selectAccountForTurn } = await routeTurn("balanced", {
      residentRoute: { kind: "account", id: "acct-second" },
      previousRouteId: "acct-first",
    });
    expect(selectAccountForTurn).toHaveBeenCalledWith(
      "anthropic",
      expect.objectContaining({ currentRouteId: "acct-second" }),
    );
  });

  it("strict routes the turn to the highest-ranked account even when it is the busiest", async () => {
    const { turnRoute, setProviderRouteCalls } = await routeTurn("strict");
    expect(turnRoute?.id).toBe("acct-first");
    expect(setProviderRouteCalls).toHaveLength(0);
  });

  it("balanced routes the turn to the least-recently-used account instead", async () => {
    const { turnRoute, setProviderRouteCalls } = await routeTurn("balanced");
    expect(turnRoute?.id).toBe("acct-second");
    expect(setProviderRouteCalls).toHaveLength(0);
  });

  it("stamps the account the turn resolved onto — the key balancing sorts by", async () => {
    const { markAccountUsed } = await routeTurn("balanced");
    expect(markAccountUsed).toHaveBeenCalledWith("anthropic", "acct-second");
  });

  it("a warm-up call selects nothing at all (docs/260 §5b)", async () => {
    const selectAccountForTurn = vi.fn();
    const markAccountUsed = vi.fn();
    const { sm, setProviderRouteCalls } = makeSessionManager({ agentPinned: true });

    await prepareSessionAgentEnvironment(new FakeRunner() as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      deps: {
        credentialsDir: tmpDir,
        credentialStore: makeCredentialStore(),
        sessionManager: sm,
        providerAccountManager: { selectAccountForTurn, markAccountUsed } as never,
      },
    });

    expect(selectAccountForTurn).not.toHaveBeenCalled();
    expect(markAccountUsed).not.toHaveBeenCalled();
    expect(setProviderRouteCalls).toHaveLength(0);
  });
});
