import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  AutoFixManager,
  AUTO_FIX_COOLDOWN_MS,
  AUTO_FIX_DEFERRED_COOLDOWN_MS,
  MAX_AUTO_FIX_ATTEMPTS,
  type AutoFixResult,
  type FetchAndFixCb,
} from "./auto-fix-manager.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { GraphQLPrNode } from "./pr-status-parser.js";
import type { SessionRunnerInterface } from "./session-runner.js";

// ---- Scaffolding ---------------------------------------------------------

type RunnerStub = EventEmitter & {
  running: boolean;
  verifyRunningState: () => Promise<boolean>;
  emitMessage: (msg: unknown) => void;
};

function makeRunner(running = false): RunnerStub {
  const r = new EventEmitter() as RunnerStub;
  r.running = running;
  r.emitMessage = () => { /* noop */ };
  r.verifyRunningState = async () => r.running;
  return r;
}

function makeSummary(state: PrStatusSummary["checks"]["state"]): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    prTitle: "t",
    prBody: "",
    prState: "open",
    baseBranch: "main",
    headBranch: "feat",
    insertions: 0,
    deletions: 0,
    checks: { state, total: 1, passed: 0, failed: state === "failure" ? 1 : 0, pending: 0 },
    mergeable: "mergeable",
    reviewDecision: "none",
    autoMergeEnabled: false,
  };
}

function makeNode(oid: string): GraphQLPrNode {
  return { commits: { nodes: [{ commit: { oid, statusCheckRollup: null } }] } } as unknown as GraphQLPrNode;
}

interface RecordingCb extends FetchAndFixCb {
  count: () => number;
}

function recordingCb(outcome: () => AutoFixResult | Promise<AutoFixResult>): RecordingCb {
  let counter = 0;
  const cb: FetchAndFixCb = async () => { counter++; return await outcome(); };
  (cb as RecordingCb).count = () => counter;
  return cb as RecordingCb;
}

function makeFixture(opts?: { enabled?: boolean; runner?: RunnerStub; cb?: RecordingCb; paused?: boolean }) {
  let time = 1_000_000;
  let enabled = opts?.enabled ?? true;
  let paused = opts?.paused ?? false;
  let runner: RunnerStub | undefined = opts?.runner ?? makeRunner(false);
  const changes: string[] = [];
  const cb = opts?.cb ?? recordingCb(() => ({ outcome: "fixed" }));
  const manager = new AutoFixManager(
    (id) => changes.push(id),
    () => runner as unknown as SessionRunnerInterface | undefined,
    () => enabled,
    cb,
    () => time,
    undefined,
    () => !paused, // docs/186 — per-session pause gate
  );
  return {
    manager,
    cb,
    changes,
    setEnabled: (v: boolean) => { enabled = v; },
    setPaused: (v: boolean) => { paused = v; },
    setRunner: (r: RunnerStub | undefined) => { runner = r; },
    advance: (ms: number) => { time += ms; },
    fail: (oid = "sha1") => manager.handleTransition("s1", makeSummary("failure"), makeNode(oid), "o", "r"),
    transition: (state: PrStatusSummary["checks"]["state"], oid = "sha1") =>
      manager.handleTransition("s1", makeSummary(state), makeNode(oid), "o", "r"),
  };
}

async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

// ---- Tests ---------------------------------------------------------------

describe("AutoFixManager", () => {
  let fx: ReturnType<typeof makeFixture>;
  beforeEach(() => { fx = makeFixture(); });

  it("fires on first FAILURE poll when idle + enabled", async () => {
    await fx.fail();
    await tick();
    expect(fx.cb.count()).toBe(1);
  });

  it("does NOT fire while disabled (global toggle off)", async () => {
    fx = makeFixture({ enabled: false });
    await fx.fail();
    await tick();
    expect(fx.cb.count()).toBe(0);
    expect(fx.manager.get("s1")).toBeUndefined();
  });

  it("docs/186 — does NOT fire while the session is paused (per-session gate off)", async () => {
    fx = makeFixture({ paused: true });
    await fx.fail();
    await tick();
    expect(fx.cb.count()).toBe(0);
    // No state created — the gate returns before the first-seen init, same as
    // the global-disabled case.
    expect(fx.manager.get("s1")).toBeUndefined();
  });

  it("docs/186 — resuming a paused session lets the next FAILURE poll fire", async () => {
    fx = makeFixture({ paused: true });
    await fx.fail();
    await tick();
    expect(fx.cb.count()).toBe(0);
    // User resumes; the gate now passes and the next poll fires.
    fx.setPaused(false);
    await fx.fail();
    await tick();
    expect(fx.cb.count()).toBe(1);
  });

  it("PENDING / none / SUCCESS never fire", async () => {
    await fx.transition("pending");
    await fx.transition("none");
    await fx.transition("success");
    await tick();
    expect(fx.cb.count()).toBe(0);
  });

  it("re-arms after a fix turn completes — the 1-attempt-budget wedge is fixed", async () => {
    // Attempt 1.
    await fx.fail();
    await tick();
    expect(fx.cb.count()).toBe(1);
    // Post-turn: re-armed to idle with a cooldown (NOT stuck in running).
    const s = fx.manager.get("s1")!;
    expect(s.status).toBe("idle");
    expect(s.attemptCount).toBe(1);
    expect(s.nextEligibleAt).toBeDefined();

    // Within cooldown — does not re-fire.
    fx.advance(AUTO_FIX_COOLDOWN_MS - 1);
    await fx.fail();
    await tick();
    expect(fx.cb.count()).toBe(1);

    // After cooldown — re-fires (attempt 2). The old loop wedged here.
    fx.advance(2);
    await fx.fail();
    await tick();
    expect(fx.cb.count()).toBe(2);
  });

  it("spends the full 3-attempt budget then exhausts", async () => {
    for (let i = 0; i < MAX_AUTO_FIX_ATTEMPTS; i++) {
      await fx.fail();
      await tick();
      fx.advance(AUTO_FIX_COOLDOWN_MS + 1);
    }
    expect(fx.cb.count()).toBe(MAX_AUTO_FIX_ATTEMPTS);
    expect(fx.manager.get("s1")?.status).toBe("exhausted");
    // Further FAILURE polls do not fire.
    await fx.fail();
    await tick();
    expect(fx.cb.count()).toBe(MAX_AUTO_FIX_ATTEMPTS);
  });

  it("CI turning green (resolved) drops the state", async () => {
    await fx.fail();
    await tick();
    expect(fx.manager.get("s1")).toBeDefined();
    await fx.transition("success");
    expect(fx.manager.get("s1")).toBeUndefined();
  });

  it("noop outcome defers without burning budget", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "noop", lastError: "no_logs" })) });
    await fx.fail();
    await tick();
    const s = fx.manager.get("s1")!;
    expect(s.attemptCount).toBe(0);
    expect(s.status).toBe("deferred");
    expect(s.nextEligibleAt).toBe(1_000_000 + AUTO_FIX_DEFERRED_COOLDOWN_MS);
  });

  it("agent running → deferred; onRunnerIdle re-fires", async () => {
    const runner = makeRunner(true);
    fx = makeFixture({ runner });
    await fx.fail();
    await tick();
    expect(fx.cb.count()).toBe(0);
    expect(fx.manager.get("s1")?.status).toBe("deferred");
    // Agent finishes.
    runner.running = false;
    await fx.manager.onRunnerIdle("s1");
    await tick();
    expect(fx.cb.count()).toBe(1);
  });

  it("head SHA change resets the attempt budget", async () => {
    await fx.fail("sha1");
    await tick();
    expect(fx.manager.get("s1")?.attemptCount).toBe(1);
    fx.advance(AUTO_FIX_COOLDOWN_MS + 1);
    await fx.fail("sha2");
    await tick();
    // New head → reset → this is attempt 1 again on the new head.
    expect(fx.manager.get("s1")?.attemptCount).toBe(1);
    expect(fx.manager.get("s1")?.lastHeadSha).toBe("sha2");
  });

  it("resetForUserActivity clears budget; next poll fires immediately", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "fixed" })) });
    await fx.fail();
    await tick();
    expect(fx.manager.get("s1")?.attemptCount).toBe(1);
    fx.manager.resetForUserActivity("s1");
    expect(fx.manager.get("s1")?.attemptCount).toBe(0);
    expect(fx.manager.get("s1")?.nextEligibleAt).toBeUndefined();
    // No cooldown now → fires again.
    await fx.fail();
    await tick();
    expect(fx.cb.count()).toBe(2);
  });

  it("markRunning (manual fix) creates state lazily and increments", () => {
    const s = fx.manager.markRunning("s1");
    expect(s.attemptCount).toBe(1);
    expect(s.status).toBe("running");
    expect(fx.manager.get("s1")?.status).toBe("running");
  });

  it("delete drops state", async () => {
    await fx.fail();
    await tick();
    expect(fx.manager.get("s1")).toBeDefined();
    fx.manager.delete("s1");
    expect(fx.manager.get("s1")).toBeUndefined();
  });
});
