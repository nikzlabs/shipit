import { describe, it, expect, vi, afterEach } from "vitest";
import { QuotaContinuationManager } from "./quota-continuation.js";
import type { QuotaContinuationDeps } from "./quota-continuation.js";
import type { CredentialRoute, SessionInfo, SessionQuotaResume } from "../../shared/types.js";
import type { ModelSelection } from "../../shared/catalogue/types.js";
import { allServices, harnessCanCarry, modeCredentialFor } from "../../shared/catalogue/index.js";
import { MAX_QUOTA_REFUSALS } from "../quota-wait.js";
import { TURN_COMPLETED, turnQuotaRefused, turnRefused, type TurnOutcome } from "../turn-settlement.js";

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
  const dispatch = vi.fn((..._args: unknown[]): unknown => ({ admitted: "started", settled: new Promise(() => {}) }));
  const runner = { agentId: "claude", running: false, agentBusy: false, disposed: false, dispatch, emitMessage: vi.fn() };

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

  // The table column, as the sessions table holds it: a restart builds a new manager over it.
  const resumes = new Map<string, string>();
  const notices: { text: string; level: string }[] = [];
  const deps = {
    sessionManager: {
      get: (id: string) => (id === session.value?.id ? session.value : undefined),
      getQuotaResume: (id: string) => {
        const json = resumes.get(id);
        return json ? (JSON.parse(json) as SessionQuotaResume) : undefined;
      },
      setQuotaResume: (id: string, resume: SessionQuotaResume | null) => {
        if (resume) resumes.set(id, JSON.stringify(resume));
        else resumes.delete(id);
      },
      listQuotaResumes: () =>
        [...resumes].map(([sessionId, json]) => ({ sessionId, resume: JSON.parse(json) as SessionQuotaResume })),
    },
    runnerRegistry: { get: () => runner, getOrCreate: () => runner, dispose: vi.fn() },
    chatHistoryManager: {
      append: (_id: string, message: { text: string; noticeLevel: string }) => {
        notices.push({ text: message.text, level: message.noticeLevel });
      },
    },
    defaultAgentId: "claude",
    credentialStore,
    providerAccountManager,
  } as unknown as QuotaContinuationDeps;

  const standDown = (manager: QuotaContinuationManager) =>
    manager.recordStandDown({ sessionId: "s1", agentId: "claude", benchedRouteId: "acct-a" });

  return { deps, session, runner, dispatch, blocked, standDown, resumes, notices };
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
    const dispatched = h.dispatch.mock.calls[0]![0] as { text: string };
    // A turn of its own, never steered into another and never queued behind one.
    expect(h.dispatch.mock.calls[0]![1]).toEqual({ whenBusy: "refuse" });
    expect(dispatched.text).toContain("A quota limit stopped your previous turn");

    manager.stop();
  });

  // docs/140-live-steering Phase 6.13 — the same wake, for a turn a renewed sign-in cut short.
  describe("a stand-down after a sign-in renewal", () => {
    const dispatchedText = (h: ReturnType<typeof makeHarness>, call: number): string =>
      (h.dispatch.mock.calls[call]![0] as { text: string }).text;

    it("counts the renewed credential itself as a way to continue", () => {
      // The only account is the one that was renewed; nothing was benched.
      const h = makeHarness({ accounts: [account("acct-a")] });
      const manager = new QuotaContinuationManager(h.deps);

      expect(manager.recordStandDown({ sessionId: "s1", agentId: "claude", cause: "auth" }))
        .toEqual({ continues: true });

      manager.stop();
    });

    it("tells the continuation turn what stopped the work", async () => {
      const quota = makeHarness();
      const quotaManager = new QuotaContinuationManager(quota.deps);
      quota.standDown(quotaManager);
      await quotaManager.continueNow("s1");

      const auth = makeHarness();
      const authManager = new QuotaContinuationManager(auth.deps);
      authManager.recordStandDown({ sessionId: "s1", agentId: "claude", cause: "auth" });
      await authManager.continueNow("s1");

      expect(dispatchedText(auth, 0)).not.toBe("");
      expect(dispatchedText(auth, 0)).not.toBe(dispatchedText(quota, 0));

      quotaManager.stop();
      authManager.stop();
    });

    it("keeps the cause across a wake that could not be delivered", async () => {
      const h = makeHarness();
      const manager = new QuotaContinuationManager(h.deps);
      manager.recordStandDown({ sessionId: "s1", agentId: "claude", cause: "auth" });
      h.dispatch.mockImplementationOnce(() => { throw new Error("container would not resume"); });

      await manager.continueNow("s1");
      await manager.sweep();

      expect(h.dispatch).toHaveBeenCalledTimes(2);
      expect(dispatchedText(h, 1)).toBe(dispatchedText(h, 0));

      manager.stop();
    });
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

  // docs/306-quota-continuation — a wake that no credential could run, from any owner.
  describe("an automatic wake that every credential refused for quota", () => {
    const T0 = Date.parse("2026-10-11T16:00:00.000Z");
    const at = (minutes: number): number => T0 + minutes * 60_000;
    const iso = (minutes: number): string => new Date(at(minutes)).toISOString();

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Each dispatched turn starts, stamps the session, and ends with `outcome()`. */
    function settleDispatches(h: ReturnType<typeof makeHarness>, outcome: () => TurnOutcome): void {
      let turn = 0;
      h.dispatch.mockImplementation((...args: unknown[]) => {
        const prepared = args[0] as { onTurnComplete?: (o: TurnOutcome) => void };
        turn += 1;
        const settled = outcome();
        h.session.value = makeSession({
          lastUsedAt: new Date(Date.now() + turn).toISOString(),
          lastTurnOutcome: settled.quotaRefused ? "quota-refused" : "ok",
        });
        prepared.onTurnComplete?.(settled);
        return { admitted: "started", settled: Promise.resolve(settled) };
      });
    }

    it("resumes the session once, at the earliest reset the providers stated", async () => {
      vi.useFakeTimers({ now: T0 });
      const h = makeHarness();
      const restoreWorkspace = vi.fn(() => Promise.resolve(true));
      (h.deps as { restoreWorkspace?: () => Promise<boolean> }).restoreWorkspace = restoreWorkspace;
      const manager = new QuotaContinuationManager(h.deps);

      manager.recordRefusedWake({ sessionId: "s1", resetsAt: [iso(80), iso(60)] });

      // The router would already re-probe a benched credential here; the stated reset decides.
      vi.setSystemTime(at(30));
      await manager.sweep();
      vi.setSystemTime(at(60) + 30_000);
      await manager.sweep();
      expect(h.dispatch).not.toHaveBeenCalled();
      // A weekly limit means days of ticks: none of them restores the workspace.
      expect(restoreWorkspace).not.toHaveBeenCalled();

      vi.setSystemTime(at(61));
      await manager.sweep();
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(1);
      expect((h.dispatch.mock.calls[0]![0] as { text: string }).text).toContain("never reached you");
      expect(h.notices).toEqual([
        { text: expect.stringContaining("ShipIt will continue it at 2026-10-11 17:01 UTC") as unknown, level: "info" },
      ]);
      expect(h.notices[0]!.text).not.toMatch(/send/i);

      manager.stop();
    });

    it("waits at least a minute when the stated reset has already passed", async () => {
      vi.useFakeTimers({ now: T0 });
      const h = makeHarness();
      const manager = new QuotaContinuationManager(h.deps);

      manager.recordRefusedWake({ sessionId: "s1", resetsAt: [iso(-10)] });
      vi.setSystemTime(at(0) + 30_000);
      await manager.sweep();
      expect(h.dispatch).not.toHaveBeenCalled();

      vi.setSystemTime(at(1) + 1_000);
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(1);

      manager.stop();
    });

    it("survives a restart: a new manager resumes what the old one recorded", async () => {
      vi.useFakeTimers({ now: T0 });
      const h = makeHarness();
      const before = new QuotaContinuationManager(h.deps);
      before.recordRefusedWake({ sessionId: "s1", resetsAt: [iso(60)] });
      before.stop();

      const after = new QuotaContinuationManager(h.deps);
      after.start();
      await vi.advanceTimersByTimeAsync(at(62) - T0);

      expect(h.dispatch).toHaveBeenCalledTimes(1);

      after.stop();
    });

    it("records a continuation that every credential refuses too, and stops after MAX_QUOTA_REFUSALS", async () => {
      vi.useFakeTimers({ now: T0 });
      const h = makeHarness();
      const manager = new QuotaContinuationManager(h.deps);
      settleDispatches(h, () => turnQuotaRefused([new Date(Date.now() + 60 * 60_000).toISOString()]));

      manager.recordRefusedWake({ sessionId: "s1", resetsAt: [iso(60)] });
      for (let hour = 1; hour <= MAX_QUOTA_REFUSALS + 1; hour++) {
        vi.setSystemTime(at(hour * 61 + 1));
        await manager.sweep();
      }

      // The owner's refusal was the first; each continuation after it is one more.
      expect(h.dispatch).toHaveBeenCalledTimes(MAX_QUOTA_REFUSALS - 1);
      expect(h.resumes.has("s1")).toBe(false);
      expect(h.notices.at(-1)).toEqual({ text: expect.stringContaining("stopped waiting") as unknown, level: "warn" });

      manager.stop();
    });

    it("records a stand-down's continuation that every credential refused, and keeps what it is told", async () => {
      vi.useFakeTimers({ now: T0 });
      const h = makeHarness();
      h.blocked.add("acct-a");
      h.blocked.add("acct-b");
      const manager = new QuotaContinuationManager(h.deps);
      manager.recordStandDown({ sessionId: "s1", agentId: "claude", cause: "auth" });
      let refuse = true;
      settleDispatches(h, () => (refuse ? turnQuotaRefused([iso(120)]) : TURN_COMPLETED));

      h.blocked.delete("acct-b");
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(1);

      refuse = false;
      vi.setSystemTime(at(119));
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(1);
      vi.setSystemTime(at(122));
      await manager.sweep();
      expect(h.dispatch).toHaveBeenCalledTimes(2);
      const text = (call: number): string => (h.dispatch.mock.calls[call]![0] as { text: string }).text;
      expect(text(1)).toBe(text(0));

      manager.stop();
    });

    it("is superseded by any turn since, also one that no credential could run", async () => {
      vi.useFakeTimers({ now: T0 });
      const refused = makeHarness();
      const ran = makeHarness();
      const managers = [refused, ran].map((h) => {
        const manager = new QuotaContinuationManager(h.deps);
        manager.recordRefusedWake({ sessionId: "s1", resetsAt: [iso(60)] });
        return manager;
      });
      refused.session.value = makeSession({ lastUsedAt: iso(10), lastTurnOutcome: "quota-refused" });
      ran.session.value = makeSession({ lastUsedAt: iso(10), lastTurnOutcome: "ok" });

      vi.setSystemTime(at(62));
      for (const manager of managers) await manager.sweep();

      for (const h of [refused, ran]) {
        expect(h.dispatch).not.toHaveBeenCalled();
        expect(h.resumes.has("s1")).toBe(false);
      }

      for (const manager of managers) manager.stop();
    });
  });

  it("keeps the entry through a restart during the wake's preparation", async () => {
    const h = makeHarness();
    const before = new QuotaContinuationManager(h.deps);
    h.blocked.add("acct-a");
    h.blocked.add("acct-b");
    h.standDown(before);
    h.blocked.delete("acct-b");
    // The workspace restore never finishes: the process ends during it.
    (h.deps as { restoreWorkspace?: () => Promise<boolean> }).restoreWorkspace = () => new Promise(() => {});
    void before.sweep();
    await Promise.resolve();
    before.stop();
    expect(h.resumes.has("s1")).toBe(true);

    (h.deps as { restoreWorkspace?: () => Promise<boolean> }).restoreWorkspace = () => Promise.resolve(true);
    const after = new QuotaContinuationManager(h.deps);
    await after.sweep();

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.resumes.has("s1")).toBe(false);

    after.stop();
  });

  it("prepares one wake at a time for a session", async () => {
    const h = makeHarness();
    const manager = new QuotaContinuationManager(h.deps);
    h.standDown(manager);
    const restores: (() => void)[] = [];
    (h.deps as { restoreWorkspace?: () => Promise<boolean> }).restoreWorkspace = () =>
      new Promise((resolve) => { restores.push(() => resolve(true)); });

    const sweep = manager.sweep();
    await Promise.resolve();
    // The executor's continuation step lands while the sweep's wake is still being prepared.
    const now = manager.continueNow("s1");
    await Promise.resolve();
    for (const restore of restores) restore();
    await Promise.all([sweep, now]);

    expect(h.dispatch).toHaveBeenCalledTimes(1);

    manager.stop();
  });

  it("starts no wake that a turn superseded during its preparation", async () => {
    const h = makeHarness();
    const manager = new QuotaContinuationManager(h.deps);
    h.standDown(manager);
    let restored!: () => void;
    (h.deps as { restoreWorkspace?: () => Promise<boolean> }).restoreWorkspace = () =>
      new Promise((resolve) => { restored = () => resolve(true); });

    const sweep = manager.sweep();
    await Promise.resolve();
    // A message of the user's starts and ends while the workspace is restored.
    h.session.value = makeSession({ lastUsedAt: "2026-09-14T12:10:00.000Z", lastTurnOutcome: "ok" });
    restored();
    await sweep;

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.resumes.has("s1")).toBe(false);

    manager.stop();
  });

  it("starts no wake whose entry a refusal replaced during its preparation", async () => {
    const h = makeHarness();
    const manager = new QuotaContinuationManager(h.deps);
    h.standDown(manager);
    let restored!: () => void;
    (h.deps as { restoreWorkspace?: () => Promise<boolean> }).restoreWorkspace = () =>
      new Promise((resolve) => { restored = () => resolve(true); });

    const sweep = manager.sweep();
    await Promise.resolve();
    // Another owner's wake is refused meanwhile; its reset is hours away.
    h.session.value = makeSession({ lastUsedAt: "2026-09-14T12:10:00.000Z", lastTurnOutcome: "quota-refused" });
    manager.recordRefusedWake({ sessionId: "s1", resetsAt: [new Date(Date.now() + 3 * 60 * 60_000).toISOString()] });
    restored();
    await sweep;

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.resumes.get("s1")).toContain("notBefore");

    manager.stop();
  });

  it("does not let a failed delivery overwrite a refusal recorded meanwhile", async () => {
    const h = makeHarness();
    const manager = new QuotaContinuationManager(h.deps);
    h.standDown(manager);
    let failed!: () => void;
    (h.deps as { restoreWorkspace?: () => Promise<boolean> }).restoreWorkspace = () =>
      new Promise((_resolve, reject) => { failed = () => reject(new Error("workspace would not restore")); });

    const sweep = manager.sweep();
    await Promise.resolve();
    h.session.value = makeSession({ lastUsedAt: "2026-09-14T12:10:00.000Z", lastTurnOutcome: "quota-refused" });
    manager.recordRefusedWake({ sessionId: "s1", resetsAt: ["2026-09-14T14:00:00.000Z"] });
    const refusal = h.resumes.get("s1");
    failed();
    await sweep;

    expect(h.resumes.get("s1")).toBe(refusal);

    manager.stop();
  });

  it("keeps the entry for the sweep when the session refuses the wake", async () => {
    const h = makeHarness();
    const manager = new QuotaContinuationManager(h.deps);
    h.standDown(manager);
    h.dispatch.mockImplementationOnce(() => ({ admitted: "refused", settled: Promise.resolve(turnRefused("busy")) }));

    await manager.continueNow("s1");
    expect(h.resumes.has("s1")).toBe(true);

    await manager.sweep();
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(h.resumes.has("s1")).toBe(false);

    manager.stop();
  });

  it("does not continue now an entry that waits for a stated reset", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-11T16:00:00.000Z") });
    const h = makeHarness();
    const restoreWorkspace = vi.fn(() => Promise.resolve(true));
    (h.deps as { restoreWorkspace?: () => Promise<boolean> }).restoreWorkspace = restoreWorkspace;
    const manager = new QuotaContinuationManager(h.deps);
    manager.recordRefusedWake({ sessionId: "s1", resetsAt: ["2026-10-11T17:00:00.000Z"] });

    await manager.continueNow("s1");

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(restoreWorkspace).not.toHaveBeenCalled();
    manager.stop();
    vi.useRealTimers();
  });

  it("leaves the continuation to the sweep while a drained turn is still in setup", async () => {
    const h = makeHarness();
    const manager = new QuotaContinuationManager(h.deps);
    h.standDown(manager);
    // The drained turn has claimed `running`, and not yet stamped the session.
    h.runner.running = true;

    await manager.continueNow("s1");

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.resumes.has("s1")).toBe(true);

    manager.stop();
  });
});
