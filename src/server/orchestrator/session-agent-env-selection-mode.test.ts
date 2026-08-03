/**
 * docs/150 req 21 — the account selection mode decides what a session pins,
 * and only at the moment it pins.
 *
 * These target `prepareSessionAgentEnvironment` rather than a full HTTP flow
 * because that function IS the pin point: it is where an unpinned session
 * resolves a route, and where an already-pinned one is honoured instead. A
 * buildApp-level test would drive a lot of transport to observe the same two
 * branches.
 *
 * Lives beside `session-agent-env.test.ts` rather than inside it because the
 * mode is one self-contained decision with its own harness, and that file is
 * already ~1200 lines across six unrelated concerns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { CredentialStore } from "./credential-store.js";
import type { SessionManager } from "./sessions.js";
import { prepareSessionAgentEnvironment } from "./session-agent-env.js";

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

describe("account selection mode at pin time (req 21)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-selection-pin-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * What a given mode pins for a brand-new session. The ordering itself is
   * unit-tested against the real implementation in
   * `provider-account-selection-mode.test.ts`; what matters here is that
   * env-prep asks, honours the answer, and stamps it.
   */
  async function pinNewSession(mode: "strict" | "balanced") {
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

    await prepareSessionAgentEnvironment(new FakeRunner() as unknown as SessionRunnerInterface, {
      sessionId: "s1",
      agentId: "claude",
      enforceAccountRouting: true,
      deps: {
        credentialsDir: tmpDir,
        credentialStore: makeCredentialStore(),
        sessionManager: sm,
        providerAccountManager: { selectAccountForTurn, markAccountUsed } as never,
      },
    });
    return { setProviderRouteCalls, markAccountUsed, selectAccountForTurn };
  }

  it("strict pins the highest-ranked account even when it is the busiest", async () => {
    const { setProviderRouteCalls } = await pinNewSession("strict");
    expect(setProviderRouteCalls.at(-1)?.routeId).toBe("acct-first");
  });

  it("balanced pins the least-recently-used account instead", async () => {
    const { setProviderRouteCalls } = await pinNewSession("balanced");
    expect(setProviderRouteCalls.at(-1)?.routeId).toBe("acct-second");
  });

  it("stamps the account the turn resolved onto — the key balancing sorts by", async () => {
    // Without this the mode is inert: `lastUsedAt` was declared on
    // ProviderAccount from the start but written by nothing, so an LRU order
    // over it would sort `undefined` against `undefined` forever.
    const { markAccountUsed } = await pinNewSession("balanced");
    expect(markAccountUsed).toHaveBeenCalledWith("claude", "acct-second");
  });

  it("does not re-route a session that is already pinned", async () => {
    // The mode is a pin-time decision. Changing it must not migrate existing
    // sessions onto other accounts behind the user's back — req 9's transcript
    // and workspace continuity depends on a session staying put until
    // something makes its own account unusable.
    const selectAccountForTurn = vi.fn();
    const markAccountUsed = vi.fn();
    const { sm, setProviderRouteCalls } = makeSessionManager({
      agentPinned: true,
      providerRouteKind: "account",
      providerRouteId: "acct-first",
    });

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

    // Never even asked: a pinned route short-circuits selection entirely.
    expect(selectAccountForTurn).not.toHaveBeenCalled();
    expect(setProviderRouteCalls).toHaveLength(0);
    // Still stamped, deliberately — an account carrying a long-lived busy
    // session must keep sorting last under `balanced` rather than ageing into
    // looking idle.
    expect(markAccountUsed).toHaveBeenCalledWith("claude", "acct-first");
  });
});
