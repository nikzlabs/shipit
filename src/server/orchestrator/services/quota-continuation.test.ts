import { describe, it, expect, vi } from "vitest";
import { QuotaContinuationManager } from "./quota-continuation.js";
import type { QuotaContinuationDeps } from "./quota-continuation.js";
import type { CredentialRoute, SessionInfo } from "../../shared/types.js";
import type { ModelSelection } from "../../shared/catalogue/types.js";
import { allServices, harnessCanCarry, modeCredentialFor } from "../../shared/catalogue/index.js";

/**
 * Any subscription the catalogue delivers to this harness as a string rather than an
 * account — the Z.ai coding plan is today's example. Derived, never named: the assertion
 * is about how such a credential is routed, not about which vendor offers one.
 */
function stringOnlySubSelectionFor(harnessId: "claude"): ModelSelection {
  for (const service of allServices()) {
    for (const mode of service.modes) {
      if (mode.kind !== "sub") continue;
      if (modeCredentialFor(service.id, mode.kind, "account") !== undefined) continue;
      const modelId = mode.models[0]?.id;
      if (!modelId) continue;
      const selection = { serviceId: service.id, billingMode: mode.kind, modelId };
      if (harnessCanCarry(harnessId, { ...selection, via: "string" })) return selection;
    }
  }
  throw new Error(`no string-delivered subscription in the catalogue for ${harnessId}`);
}

const ANTHROPIC_SUB = { serviceId: "anthropic", billingMode: "sub" as const };

function account(id: string, over: Partial<CredentialRoute> = {}): CredentialRoute {
  return {
    id,
    ...ANTHROPIC_SUB,
    via: "account",
    label: id,
    isPrimary: false,
    priority: 0,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as CredentialRoute;
}

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "A session",
    createdAt: "2026-09-14T11:00:00.000Z",
    lastUsedAt: "2026-09-14T12:00:00.000Z",
    workspaceDir: "/tmp/s1",
    agentId: "claude",
    model: "claude-opus-5",
    ...ANTHROPIC_SUB,
    ...over,
  } as SessionInfo;
}

/**
 * Routes the real selector over a fake store, so the harness exercises
 * `selectRouteForSelection` rather than a stand-in for it.
 */
function makeHarness(opts?: { accounts?: CredentialRoute[]; strings?: CredentialRoute[] }) {
  const session: { value: SessionInfo | undefined } = { value: makeSession() };
  const accounts = opts?.accounts ?? [account("acct-a"), account("acct-b")];
  const strings = opts?.strings ?? [];
  const blocked = new Set<string>();
  const dispatch = vi.fn();
  const runner = { agentId: "claude", running: false, agentBusy: false, disposed: false, dispatch };

  const listCredentialRoutes = (serviceId: string, billingMode: string): CredentialRoute[] =>
    [...accounts, ...strings].filter(
      (route) => route.serviceId === serviceId && route.billingMode === billingMode,
    );

  const credentialStore = {
    listCredentialRoutes,
    getCredentialRoute: (id: string) => listCredentialRoutes("anthropic", "sub").find((r) => r.id === id),
    getCredentialSecret: (id: string) => (strings.some((r) => r.id === id) ? "sk-test" : undefined),
    getSelectionMode: () => "strict",
    getFailoverCutoffs: () => ({ session: 100, weekly: 100 }),
  };

  const providerAccountManager = {
    // Mirrors the real manager closely enough for the selector: ready rows, refusal memory.
    selectAccountForTurn: (serviceId: string, selectOpts: { exclude?: readonly string[] } = {}) => {
      const exclude = new Set(selectOpts.exclude ?? []);
      const free = accounts.filter(
        (a) => a.serviceId === serviceId && !exclude.has(a.id) && !blocked.has(a.id),
      );
      if (free[0]) return { ok: true as const, route: { kind: "account" as const, id: free[0].id } };
      return { ok: false as const, reason: "all_exhausted" as const, earliestResetAt: null };
    },
    subscriptionLimitsFor: () => ({}),
    getByRouteId: (id: string) => accounts.find((a) => a.id === id),
  };

  const deps = {
    sessionManager: { get: (id: string) => (id === session.value?.id ? session.value : undefined) },
    runnerRegistry: { get: () => runner, getOrCreate: () => runner, dispose: vi.fn() },
    defaultAgentId: "claude",
    credentialStore,
    providerAccountManager,
  } as unknown as QuotaContinuationDeps;

  const standDown = (manager: QuotaContinuationManager) =>
    manager.recordStandDown({ sessionId: "s1", agentId: "claude", benchedRouteId: "acct-a" });

  return { deps, session, runner, dispatch, blocked, standDown };
}

describe("quota continuation", () => {
  it("continues when another credential is free", () => {
    const h = makeHarness();
    const manager = new QuotaContinuationManager(h.deps);

    expect(h.standDown(manager)).toEqual({ continues: true });

    manager.stop();
  });

  it("does not count the credential the turn just spent as a way to continue", () => {
    // acct-a is the only account, and it is the one that refused.
    const h = makeHarness({ accounts: [account("acct-a")] });
    const manager = new QuotaContinuationManager(h.deps);

    expect(h.standDown(manager)).toEqual({ continues: false });

    manager.stop();
  });

  // Asking the account router alone would answer about the harness's native service, which
  // is the wrong question for a subscription delivered as a string.
  describe("a subscription the harness carries as a string", () => {
    const selection = stringOnlySubSelectionFor("claude");
    const stringCredential = (id: string, over: Partial<CredentialRoute> = {}): CredentialRoute =>
      account(id, {
        id,
        via: "string",
        serviceId: selection.serviceId,
        billingMode: selection.billingMode,
        ...over,
      });

    it("counts one that is free", () => {
      const h = makeHarness({ accounts: [], strings: [stringCredential("cred_plan")] });
      h.session.value = makeSession({ ...selection, model: selection.modelId });
      const manager = new QuotaContinuationManager(h.deps);

      expect(h.standDown(manager)).toEqual({ continues: true });

      manager.stop();
    });

    it("does not borrow the harness's account credentials when it has none of its own", () => {
      const h = makeHarness({ accounts: [account("acct-a"), account("acct-b")], strings: [] });
      h.session.value = makeSession({ ...selection, model: selection.modelId });
      const manager = new QuotaContinuationManager(h.deps);

      expect(h.standDown(manager)).toEqual({ continues: false });

      manager.stop();
    });
  });

  it("dispatches the continuation turn on the session's runner", async () => {
    const h = makeHarness();
    const manager = new QuotaContinuationManager(h.deps);
    h.standDown(manager);

    await manager.continueNow("s1");

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const dispatched = h.dispatch.mock.calls[0]![0] as { text: string; systemTurn: boolean };
    expect(dispatched.systemTurn).toBe(true);
    expect(dispatched.text).toContain("A quota limit stopped your previous turn");

    manager.stop();
  });

  it("leaves the continuation to a turn that has already taken the session on", async () => {
    const h = makeHarness();
    const manager = new QuotaContinuationManager(h.deps);
    h.standDown(manager);

    // A queued message drained while the stopped turn was still tearing down.
    h.session.value = makeSession({ lastUsedAt: "2026-09-14T12:00:05.000Z" });
    await manager.continueNow("s1");

    expect(h.dispatch).not.toHaveBeenCalled();

    manager.stop();
  });

  it("does not continue an archived session", async () => {
    const h = makeHarness();
    const manager = new QuotaContinuationManager(h.deps);
    h.session.value = makeSession({ userArchived: true });

    expect(h.standDown(manager)).toEqual({ continues: false });
    await manager.continueNow("s1");
    await manager.sweep();

    expect(h.dispatch).not.toHaveBeenCalled();

    manager.stop();
  });

  describe("when every credential is spent", () => {
    function spentHarness() {
      const h = makeHarness();
      h.blocked.add("acct-a");
      h.blocked.add("acct-b");
      return h;
    }

    it("resumes the session once a credential is free again", async () => {
      const h = spentHarness();
      const manager = new QuotaContinuationManager(h.deps);

      expect(h.standDown(manager)).toEqual({ continues: false });

      await manager.sweep();
      expect(h.dispatch).not.toHaveBeenCalled();

      h.blocked.delete("acct-b");
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(1);

      // At most one wake per stall: the session is forgotten once resumed.
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(1);

      manager.stop();
    });

    it("forgets a session that has run a turn since the stand-down", async () => {
      const h = spentHarness();
      const manager = new QuotaContinuationManager(h.deps);
      h.standDown(manager);

      // Only the later turn stands between this session and a wake.
      h.blocked.delete("acct-b");
      h.session.value = makeSession({ lastUsedAt: "2026-09-14T13:30:00.000Z" });
      await manager.sweep();

      expect(h.dispatch).not.toHaveBeenCalled();

      manager.stop();
    });

    it("waits while the stopped turn's own post-turn work is still in flight", async () => {
      const h = spentHarness();
      const manager = new QuotaContinuationManager(h.deps);
      h.standDown(manager);

      h.blocked.delete("acct-b");
      // running has already cleared, but the commit and push have not finished.
      h.runner.agentBusy = true;
      await manager.sweep();
      expect(h.dispatch).not.toHaveBeenCalled();

      h.runner.agentBusy = false;
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(1);

      manager.stop();
    });

    it("retries a wake that could not be delivered, up to three attempts", async () => {
      const h = spentHarness();
      const manager = new QuotaContinuationManager(h.deps);
      h.standDown(manager);
      h.blocked.delete("acct-b");
      h.dispatch.mockImplementation(() => { throw new Error("container would not resume"); });

      await manager.sweep();
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(2);

      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(3);

      // Three failures is the bound; a session that cannot be resumed is not woken forever.
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(3);

      manager.stop();
    });
  });
});
