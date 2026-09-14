import { describe, it, expect, vi } from "vitest";
import { QuotaContinuationManager } from "./quota-continuation.js";
import type { QuotaContinuationDeps } from "./quota-continuation.js";
import type { AccountSelection, SelectAccountOptions } from "../provider-account-manager.js";
import type { SessionInfo } from "../../shared/types.js";

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "A session",
    createdAt: "2026-09-14T11:00:00.000Z",
    lastUsedAt: "2026-09-14T12:00:00.000Z",
    workspaceDir: "/tmp/s1",
    agentId: "claude",
    serviceId: "anthropic",
    ...over,
  } as SessionInfo;
}

function makeHarness(opts?: { selection?: () => AccountSelection }) {
  const session: { value: SessionInfo | undefined } = { value: makeSession() };
  const dispatch = vi.fn();
  const runner = { agentId: "claude", running: false, disposed: false, dispatch };
  const selectCalls: { serviceId: string; opts: SelectAccountOptions }[] = [];
  const selection = opts?.selection ?? ((): AccountSelection => ({
    ok: true,
    route: { kind: "account", id: "acct-b" },
  }));

  const deps = {
    sessionManager: { get: (id: string) => (id === session.value?.id ? session.value : undefined) },
    runnerRegistry: {
      get: () => runner,
      getOrCreate: () => runner,
      dispose: vi.fn(),
    },
    defaultAgentId: "claude",
    providerAccountManager: {
      selectAccountForTurn: (serviceId: string, selectOpts: SelectAccountOptions = {}) => {
        selectCalls.push({ serviceId, opts: selectOpts });
        return selection();
      },
      getByRouteId: (routeId: string) =>
        routeId === "acct-a" ? { id: "acct-a", serviceId: "anthropic" } : undefined,
    },
  } as unknown as QuotaContinuationDeps;

  return { deps, session, runner, dispatch, selectCalls };
}

describe("quota continuation", () => {
  it("continues on another credential, excluding the account the turn just spent", () => {
    const h = makeHarness();
    const manager = new QuotaContinuationManager(h.deps);

    expect(
      manager.recordStandDown({ sessionId: "s1", agentId: "claude", benchedRouteId: "acct-a" }),
    ).toEqual({ continues: true });
    expect(h.selectCalls).toEqual([{ serviceId: "anthropic", opts: { exclude: ["acct-a"] } }]);

    manager.stop();
  });

  it("dispatches the continuation turn on the session's runner", async () => {
    const h = makeHarness();
    const manager = new QuotaContinuationManager(h.deps);

    await manager.continueNow("s1");

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const dispatched = h.dispatch.mock.calls[0]![0] as { text: string; systemTurn: boolean };
    expect(dispatched.systemTurn).toBe(true);
    expect(dispatched.text).toContain("quota limit stopped the turn you had started on your own");

    manager.stop();
  });

  it("does not continue an archived session", async () => {
    const h = makeHarness();
    h.session.value = makeSession({ userArchived: true });
    const manager = new QuotaContinuationManager(h.deps);

    expect(
      manager.recordStandDown({ sessionId: "s1", agentId: "claude", benchedRouteId: "acct-a" }),
    ).toEqual({ continues: false });
    await manager.continueNow("s1");
    expect(h.dispatch).not.toHaveBeenCalled();
    // An archived session is not remembered either; the sweep must never wake it.
    await manager.sweep();
    expect(h.dispatch).not.toHaveBeenCalled();

    manager.stop();
  });

  describe("when every credential is spent", () => {
    const allSpent = (): AccountSelection => ({
      ok: false,
      reason: "all_exhausted",
      earliestResetAt: "2026-09-14T12:50:00.000Z",
    });

    it("resumes the session once a credential is free again", async () => {
      let spent = true;
      const h = makeHarness({
        selection: () => (spent ? allSpent() : { ok: true, route: { kind: "account", id: "acct-b" } }),
      });
      const manager = new QuotaContinuationManager(h.deps);

      expect(
        manager.recordStandDown({ sessionId: "s1", agentId: "claude", benchedRouteId: "acct-a" }),
      ).toEqual({ continues: false });

      await manager.sweep();
      expect(h.dispatch).not.toHaveBeenCalled();

      spent = false;
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(1);

      // At most one wake per bench: the session is forgotten once resumed.
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(1);

      manager.stop();
    });

    it("forgets a session that has run a turn since the stand-down", async () => {
      let spent = true;
      const h = makeHarness({
        selection: () => (spent ? allSpent() : { ok: true, route: { kind: "account", id: "acct-b" } }),
      });
      const manager = new QuotaContinuationManager(h.deps);
      manager.recordStandDown({ sessionId: "s1", agentId: "claude", benchedRouteId: "acct-a" });

      // Only the later turn stands between this session and a wake.
      spent = false;
      h.session.value = makeSession({ lastUsedAt: "2026-09-14T13:30:00.000Z" });
      await manager.sweep();

      expect(h.dispatch).not.toHaveBeenCalled();

      manager.stop();
    });

    it("leaves a session that is running a turn for a later sweep", async () => {
      let spent = true;
      const h = makeHarness({
        selection: () => (spent ? allSpent() : { ok: true, route: { kind: "account", id: "acct-b" } }),
      });
      const manager = new QuotaContinuationManager(h.deps);
      manager.recordStandDown({ sessionId: "s1", agentId: "claude", benchedRouteId: "acct-a" });

      spent = false;
      h.runner.running = true;
      await manager.sweep();
      expect(h.dispatch).not.toHaveBeenCalled();

      h.runner.running = false;
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(1);

      manager.stop();
    });
  });
});
