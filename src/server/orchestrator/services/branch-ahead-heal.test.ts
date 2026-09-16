import { describe, it, expect, vi } from "vitest";
import {
  BranchAheadHealer,
  HEAL_BASE_COOLDOWN_MS,
  HEAL_MAX_COOLDOWN_MS,
  type AheadHealRunner,
} from "./branch-ahead-heal.js";
import type { SessionInfo } from "../../shared/types.js";
import type { BranchSyncStatus, PrStatusSummary } from "../../shared/types/github-types.js";

const AHEAD: BranchSyncStatus = { state: "ahead", ahead: 2, behind: 0 };

function setup(opts: {
  runner?: Partial<AheadHealRunner>;
  pushArmed?: boolean;
  head?: string | null;
  session?: Partial<SessionInfo>;
  prStatus?: PrStatusSummary | null;
  now?: () => number;
} = {}) {
  const schedule = vi.fn();
  const getHeadHash = vi.fn(async () => (opts.head === undefined ? "head1" : opts.head));
  const isAncestor = vi.fn(async () => true);
  const healer = new BranchAheadHealer({
    getRunner: () =>
      opts.runner
        ? ({ agentBusy: false, systemTurnInProgress: false, ...opts.runner })
        : undefined,
    pushArmed: () => opts.pushArmed === true,
    ...(opts.now ? { now: opts.now } : {}),
  });
  // Rest args, not a default: an explicit `undefined` sync is its own case.
  const heal = (...sync: [BranchSyncStatus | undefined] | []) =>
    healer.heal({
      sessionId: "s1",
      session: { id: "s1", ...opts.session } as SessionInfo,
      sync: sync.length > 0 ? sync[0] : AHEAD,
      git: { getHeadHash, isAncestor },
      getPrStatus: () => opts.prStatus ?? null,
      schedule,
    });
  return { healer, heal, schedule, getHeadHash };
}

describe("BranchAheadHealer", () => {
  it("schedules a push for an ahead branch on an idle session", async () => {
    const { heal, schedule } = setup();
    expect(await heal()).toEqual({ action: "scheduled", attempt: 1 });
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("holds while the agent is busy", async () => {
    const { heal, schedule } = setup({ runner: { agentBusy: true } });
    expect(await heal()).toEqual({ action: "skip", reason: "busy" });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("holds while a system turn is rewriting the branch", async () => {
    const { heal, schedule } = setup({ runner: { systemTurnInProgress: true } });
    expect(await heal()).toEqual({ action: "skip", reason: "busy" });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("holds while the shared scheduler already has a push armed", async () => {
    const { heal, schedule } = setup({ pushArmed: true });
    expect(await heal()).toEqual({ action: "skip", reason: "push-armed" });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("leaves a diverged branch held — force-pushing it would discard the remote", async () => {
    const { heal, schedule } = setup();
    const diverged: BranchSyncStatus = { state: "diverged", ahead: 2, behind: 3 };
    expect(await heal(diverged)).toEqual({ action: "skip", reason: "not-ahead" });
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each([
    ["in-sync", { state: "in-sync", ahead: 0, behind: 0 }],
    ["behind", { state: "behind", ahead: 0, behind: 5 }],
  ] as const)("does nothing for a %s branch", async (_label, sync) => {
    const { heal, schedule } = setup();
    expect(await heal(sync)).toEqual({ action: "skip", reason: "not-ahead" });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("refuses a branch stacked on a merged pull request", async () => {
    const { heal, schedule } = setup({
      session: { mergedAt: new Date().toISOString(), mergedHeadSha: "merged1" },
    });
    expect(await heal()).toEqual({ action: "skip", reason: "merged" });
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each(["sandbox", "ops"] as const)("never writes for a kind=%s session", async (kind) => {
    const { heal, schedule } = setup({ session: { kind } });
    expect(await heal()).toEqual({ action: "skip", reason: "kind" });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("leaves a secret-blocked session alone", async () => {
    const { heal, schedule } = setup({
      session: { secretBlock: { findings: [], at: "2026-01-01T00:00:00Z", notifyCount: 0 } },
    });
    expect(await heal()).toEqual({ action: "skip", reason: "secret-blocked" });
    expect(schedule).not.toHaveBeenCalled();
  });

  // The decision awaits git twice. A turn that starts in that window owns the
  // branch, and the push it will arm must not be pre-empted by this one.
  it("re-checks for a turn that started while it was reading git", async () => {
    let busy = false;
    const schedule = vi.fn();
    const healer = new BranchAheadHealer({
      getRunner: () => ({ agentBusy: busy, systemTurnInProgress: false }),
      pushArmed: () => false,
    });
    const outcome = await healer.heal({
      sessionId: "s1",
      session: { id: "s1" } as SessionInfo,
      sync: AHEAD,
      git: {
        getHeadHash: async () => { busy = true; return "head1"; },
        isAncestor: async () => true,
      },
      getPrStatus: () => null,
      schedule,
    });
    expect(outcome).toEqual({ action: "skip", reason: "busy" });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("re-checks for a push the turn path armed while it was reading git", async () => {
    let armed = false;
    const schedule = vi.fn();
    const healer = new BranchAheadHealer({
      getRunner: () => undefined,
      pushArmed: () => armed,
    });
    const outcome = await healer.heal({
      sessionId: "s1",
      session: { id: "s1" } as SessionInfo,
      sync: AHEAD,
      git: {
        getHeadHash: async () => { armed = true; return "head1"; },
        isAncestor: async () => true,
      },
      getPrStatus: () => null,
      schedule,
    });
    expect(outcome).toEqual({ action: "skip", reason: "push-armed" });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("cannot decide without a HEAD to key the attempt on", async () => {
    const { heal, schedule } = setup({ head: null });
    expect(await heal()).toEqual({ action: "skip", reason: "unknown-head" });
    expect(schedule).not.toHaveBeenCalled();
  });

  describe("back-off", () => {
    it("does not re-fire on the very next poll of the same tip", async () => {
      let now = 1_000_000;
      const { heal, schedule } = setup({ now: () => now });
      await heal();
      now += 15_000;
      expect(await heal()).toEqual({ action: "skip", reason: "cooling-down" });
      expect(schedule).toHaveBeenCalledTimes(1);
    });

    it("retries after the cooldown, and widens it each time the tip stays stuck", async () => {
      let now = 1_000_000;
      const { heal, schedule } = setup({ now: () => now });
      await heal();

      now += HEAL_BASE_COOLDOWN_MS;
      expect(await heal()).toEqual({ action: "scheduled", attempt: 2 });

      // The second attempt's cooldown is twice the first: the same wait is now too short.
      now += HEAL_BASE_COOLDOWN_MS;
      expect(await heal()).toEqual({ action: "skip", reason: "cooling-down" });
      now += HEAL_BASE_COOLDOWN_MS;
      expect(await heal()).toEqual({ action: "scheduled", attempt: 3 });

      expect(schedule).toHaveBeenCalledTimes(3);
    });

    it("caps the wait so a long-stuck branch still converges", async () => {
      let now = 1_000_000;
      const { heal } = setup({ now: () => now });
      for (let i = 0; i < 12; i++) {
        now += HEAL_MAX_COOLDOWN_MS;
        await heal();
      }
      now += HEAL_MAX_COOLDOWN_MS;
      expect((await heal()).action).toBe("scheduled");
    });

    it("restarts the budget when new commits arrive", async () => {
      let now = 1_000_000;
      let head = "head1";
      const schedule = vi.fn();
      const healer = new BranchAheadHealer({
        getRunner: () => undefined,
        pushArmed: () => false,
        now: () => now,
      });
      const heal = () =>
        healer.heal({
          sessionId: "s1",
          session: { id: "s1" } as SessionInfo,
          sync: AHEAD,
          git: { getHeadHash: async () => head, isAncestor: async () => true },
          getPrStatus: () => null,
          schedule,
        });

      expect(await heal()).toEqual({ action: "scheduled", attempt: 1 });
      now += 1000;
      expect(await heal()).toEqual({ action: "skip", reason: "cooling-down" });
      head = "head2";
      expect(await heal()).toEqual({ action: "scheduled", attempt: 1 });
    });

    it("keeps the budget when the state could not be read — that is no evidence of recovery", async () => {
      let now = 1_000_000;
      const { heal, schedule } = setup({ now: () => now });
      await heal();
      expect(await heal(undefined)).toEqual({ action: "skip", reason: "not-ahead" });
      now += 1000;
      expect(await heal()).toEqual({ action: "skip", reason: "cooling-down" });
      expect(schedule).toHaveBeenCalledTimes(1);
    });

    it("forgets the branch once it reaches its remote, so the next stall starts fresh", async () => {
      let now = 1_000_000;
      const { heal, schedule } = setup({ now: () => now });
      await heal();
      await heal({ state: "in-sync", ahead: 0, behind: 0 });
      now += 1000;
      expect(await heal()).toEqual({ action: "scheduled", attempt: 1 });
      expect(schedule).toHaveBeenCalledTimes(2);
    });

    it("forget() clears a session's history explicitly", async () => {
      let now = 1_000_000;
      const { healer, heal } = setup({ now: () => now });
      await heal();
      healer.forget("s1");
      now += 1000;
      expect(await heal()).toEqual({ action: "scheduled", attempt: 1 });
    });

    it("a hold costs no attempt — the budget is for pushes actually tried", async () => {
      let now = 1_000_000;
      const busy = { agentBusy: true };
      const schedule = vi.fn();
      const healer = new BranchAheadHealer({
        getRunner: () => ({ systemTurnInProgress: false, ...busy }),
        pushArmed: () => false,
        now: () => now,
      });
      const heal = () =>
        healer.heal({
          sessionId: "s1",
          session: { id: "s1" } as SessionInfo,
          sync: AHEAD,
          git: { getHeadHash: async () => "head1", isAncestor: async () => true },
          getPrStatus: () => null,
          schedule,
        });

      await heal();
      await heal();
      busy.agentBusy = false;
      now += 1000;
      expect(await heal()).toEqual({ action: "scheduled", attempt: 1 });
    });
  });
});
