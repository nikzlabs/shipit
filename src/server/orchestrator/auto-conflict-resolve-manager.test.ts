import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  AutoConflictResolveManager,
  AUTO_RESOLVE_COOLDOWN_MS,
  AUTO_RESOLVE_DEFERRED_COOLDOWN_MS,
  AUTO_RESOLVE_SETTLE_MS,
  MAX_AUTO_RESOLVE_ATTEMPTS,
  type AutoResolveResult,
  type RebaseAndResolveCb,
} from "./auto-conflict-resolve-manager.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { SessionRunnerInterface } from "./session-runner.js";

type RunnerStub = EventEmitter & {
  running: boolean;
  verifyRunningState: () => Promise<boolean>;
  emitMessage: (msg: unknown) => void;
  emitted: unknown[];
  onVerify?: () => Promise<boolean> | boolean;
};

function makeRunner(running = false): RunnerStub {
  const r = new EventEmitter() as RunnerStub;
  r.running = running;
  r.emitted = [];
  r.emitMessage = (msg: unknown) => { r.emitted.push(msg); };
  r.verifyRunningState = async () => {
    if (r.onVerify) return await r.onVerify();
    return r.running;
  };
  return r;
}

function makeSummary(opts: Partial<PrStatusSummary> & { mergeable: PrStatusSummary["mergeable"] }): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    prTitle: "test",
    prBody: "",
    prState: "open",
    baseBranch: "main",
    headBranch: "feat",
    insertions: 0,
    deletions: 0,
    checks: { state: "pending", total: 0, passed: 0, failed: 0, pending: 0 },
    reviewDecision: "none",
    autoMergeEnabled: false,
    ...opts,
  };
}

interface Fixture {
  manager: AutoConflictResolveManager;
  readonly runner: RunnerStub | undefined;
  setRunner: (r: RunnerStub | undefined) => void;
  setEnabled: (v: boolean) => void;
  changes: string[];
  cb: RecordingCb;
  advance: (ms: number) => void;
  setNow: (n: number) => void;
}

interface RecordingCb extends RebaseAndResolveCb {
  calls: { sessionId: string; baseBranch: string; attempt: number }[];
  readonly count: number;
}

function recordingCb(
  outcome: (sessionId: string, baseBranch: string, attempt: number) => Promise<AutoResolveResult> | AutoResolveResult,
): RecordingCb {
  const calls: { sessionId: string; baseBranch: string; attempt: number }[] = [];
  let counter = 0;
  const cb: RebaseAndResolveCb = async (sessionId, baseBranch) => {
    counter++;
    calls.push({ sessionId, baseBranch, attempt: counter });
    return await outcome(sessionId, baseBranch, counter);
  };
  (cb as RecordingCb).calls = calls;
  Object.defineProperty(cb, "count", { get: () => counter });
  return cb as RecordingCb;
}

function makeFixture(opts?: {
  initialRunner?: RunnerStub | undefined;
  enabled?: boolean;
  cb?: RecordingCb;
}): Fixture {
  let time = 1_000_000;
  let enabled = opts?.enabled ?? true;
  let runner: RunnerStub | undefined = opts?.initialRunner ?? makeRunner(false);
  const changes: string[] = [];
  const cb = opts?.cb ?? recordingCb(() => ({ outcome: "success", forcePushed: true, didWork: true }));
  const manager = new AutoConflictResolveManager(
    (id) => changes.push(id),
    (() => runner as unknown as SessionRunnerInterface | undefined),
    () => enabled,
    cb,
    () => time,
  );
  return {
    manager,
    get runner() { return runner; },
    setRunner: (r) => { runner = r; },
    setEnabled: (v) => { enabled = v; },
    changes,
    cb,
    advance: (ms) => { time += ms; },
    setNow: (n) => { time = n; },
  } as Fixture;
}

async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe("AutoConflictResolveManager", () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });

  it("1. fires once on first conflicting poll when idle + enabled", async () => {
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.calls).toEqual([{ sessionId: "s1", baseBranch: "main", attempt: 1 }]);
  });

  it("2. additional conflicting polls do NOT re-fire while running", async () => {
    fx = makeFixture({ cb: recordingCb(() => new Promise(() => { /* never resolve */ })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(1);
    expect(fx.manager.get("s1")?.status).toBe("running");
  });

  it("3. agent running → deferred, callback does NOT fire", async () => {
    const runner = makeRunner(true);
    fx.setRunner(runner);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.cb.count).toBe(0);
    expect(fx.manager.get("s1")?.status).toBe("deferred");
  });

  it("3. no runner → deferred, callback does NOT fire", async () => {
    fx.setRunner(undefined);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.cb.count).toBe(0);
    expect(fx.manager.get("s1")?.status).toBe("deferred");
  });

  it("4. onRunnerIdle with sticky conflict from deferred fires the callback", async () => {
    const runner = makeRunner(true);
    fx.setRunner(runner);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.cb.count).toBe(0);
    runner.running = false;
    await fx.manager.onRunnerIdle("s1");
    expect(fx.cb.count).toBe(1);
  });

  it("5. onRunnerIdle after conflict resolved (mergeable in cache) does NOT fire", async () => {
    const runner = makeRunner(true);
    fx.setRunner(runner);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "mergeable" }), "main", "sha1");
    runner.running = false;
    await fx.manager.onRunnerIdle("s1");
    expect(fx.cb.count).toBe(0);
  });

  it("6. UNKNOWN polls do not touch cache or fire", async () => {
    fx = makeFixture({ cb: recordingCb(() => new Promise(() => { /* never resolves */ })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.cb.count).toBe(1);
    expect(fx.manager.getLastKnownMergeable("s1")).toBe("conflicting");
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "unknown" }), "main", "sha1");
    expect(fx.manager.getLastKnownMergeable("s1")).toBe("conflicting");
    expect(fx.cb.count).toBe(1);
  });

  it("7. head SHA change resets attempt counter", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "error", lastError: "boom", didWork: true })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.manager.get("s1")?.attemptCount).toBe(1);
    fx.advance(AUTO_RESOLVE_COOLDOWN_MS + 1);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha2");
    await tick();
    expect(fx.manager.get("s1")?.attemptCount).toBe(1);
    expect(fx.manager.get("s1")?.lastHeadSha).toBe("sha2");
  });

  it("8. three errored attempts → exhausted; subsequent polls do not fire", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "error", lastError: "boom", didWork: true })) });
    for (let i = 0; i < MAX_AUTO_RESOLVE_ATTEMPTS; i++) {
      await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
      await tick();
      fx.advance(AUTO_RESOLVE_COOLDOWN_MS + 1);
    }
    expect(fx.cb.count).toBe(MAX_AUTO_RESOLVE_ATTEMPTS);
    expect(fx.manager.get("s1")?.status).toBe("exhausted");
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(MAX_AUTO_RESOLVE_ATTEMPTS);
  });

  it("9. cooldown blocks then expires — sticky conflict re-fires without edge transition", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "error", lastError: "boom", didWork: true })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(1);
    fx.advance(AUTO_RESOLVE_COOLDOWN_MS - 1);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(1);
    fx.advance(2);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(2);
  });

  it("10. setting flipped off while running → in-flight writeBack runs, subsequent polls early-return", async () => {
    let resolveCb: (r: AutoResolveResult) => void = () => { /* set below */ };
    fx = makeFixture({ cb: recordingCb(() => new Promise<AutoResolveResult>((r) => { resolveCb = r; })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.cb.count).toBe(1);
    fx.setEnabled(false);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.cb.count).toBe(1);
    resolveCb({ outcome: "success", forcePushed: true, didWork: true });
    await tick();
    expect(fx.manager.get("s1")?.status).toBe("idle");
    expect(fx.manager.get("s1")?.attemptCount).toBe(1);
  });

  it("11. resetForUserActivity clears budget; next poll fires immediately", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "error", lastError: "boom", didWork: true })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    fx.advance(AUTO_RESOLVE_COOLDOWN_MS + 1);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(2);
    fx.manager.resetForUserActivity("s1");
    expect(fx.manager.get("s1")?.attemptCount).toBe(0);
    expect(fx.manager.get("s1")?.nextEligibleAt).toBeUndefined();
    expect(fx.manager.get("s1")?.lastError).toBeUndefined();
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(3);
  });

  it("12. delete clears both maps; later transitions behave first-seen", async () => {
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.manager.get("s1")).toBeDefined();
    fx.manager.delete("s1");
    expect(fx.manager.get("s1")).toBeUndefined();
    expect(fx.manager.getLastKnownMergeable("s1")).toBeUndefined();
  });

  it("13. deferred writeBack leaves attemptCount unchanged", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "deferred", lastError: "dirty_tree", didWork: false })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.manager.get("s1")?.attemptCount).toBe(0);
    expect(fx.manager.get("s1")?.status).toBe("deferred");
    expect(fx.manager.get("s1")?.nextEligibleAt).toBeDefined();
  });

  it("14. success with forcePushed=false records lease cooldown, status idle, no exhaustion", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "success", forcePushed: false, didWork: true })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    const s = fx.manager.get("s1")!;
    expect(s.attemptCount).toBe(1);
    expect(s.status).toBe("idle");
    expect(s.lastError).toBe("force_push_failed");
    expect(s.nextEligibleAt).toBeDefined();
    const emit = fx.runner!.emitted.find((m: unknown) => (m as { type?: string }).type === "auto_resolve_result") as { outcome: string; forcePushed?: boolean };
    expect(emit?.outcome).toBe("success");
    expect(emit?.forcePushed).toBe(false);
  });

  it("15. exhausted envelope carries lastError", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "error", lastError: "boom", didWork: true })) });
    for (let i = 0; i < MAX_AUTO_RESOLVE_ATTEMPTS; i++) {
      await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
      await tick();
      fx.advance(AUTO_RESOLVE_COOLDOWN_MS + 1);
    }
    const emits = fx.runner!.emitted.filter((m: unknown) => (m as { type?: string }).type === "auto_resolve_result") as { outcome: string; lastError?: string; attempt: number }[];
    const exhausted = emits.find((e) => e.outcome === "exhausted");
    expect(exhausted).toBeDefined();
    expect(exhausted?.lastError).toBe("boom");
    expect(exhausted?.attempt).toBe(MAX_AUTO_RESOLVE_ATTEMPTS);
  });

  it("16. lastKnownMergeable is cached while disabled; first-enable poll fires correctly", async () => {
    fx.setEnabled(false);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.manager.getLastKnownMergeable("s1")).toBe("conflicting");
    expect(fx.cb.count).toBe(0);
    expect(fx.manager.get("s1")).toBeUndefined();
    fx.setEnabled(true);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(1);
  });

  it("17. toggle off then on preserves cooldown across the toggle", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "error", lastError: "boom", didWork: true })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.manager.get("s1")?.nextEligibleAt).toBeDefined();
    fx.setEnabled(false);
    fx.setEnabled(true);
    fx.advance(AUTO_RESOLVE_COOLDOWN_MS - 1);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(1);
  });

  it("18. cache snapshot read happens before cache write (regression for earlier algorithm bug)", async () => {
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "mergeable" }), "main", "sha1");
    expect(fx.manager.getLastKnownMergeable("s1")).toBeUndefined();
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.manager.getLastKnownMergeable("s1")).toBe("conflicting");
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.manager.getLastKnownMergeable("s1")).toBe("conflicting");
  });

  it("re-entrancy guard: verifyRunningState synchronously emits idle → callback fires exactly once", async () => {
    const runner = makeRunner(true);
    runner.onVerify = () => {
      runner.running = false;
      runner.emit("idle");
      return false;
    };
    fx.setRunner(runner);
    runner.on("idle", () => { void fx.manager.onRunnerIdle("s1"); });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(1);
  });

  it("dedup: back-to-back deferred outcomes don't double-emit auto_resolve_result", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "deferred", lastError: "dirty_tree", didWork: false })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    fx.advance(AUTO_RESOLVE_DEFERRED_COOLDOWN_MS + 1);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    const emits = fx.runner!.emitted.filter((m: unknown) => (m as { type?: string }).type === "auto_resolve_result");
    expect(emits.length).toBe(1);
  });

  it("settle: a successful force-push opens a settle window (settleUntil + cooldown set)", async () => {
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    const s = fx.manager.get("s1")!;
    expect(s.attemptCount).toBe(1);
    expect(s.status).toBe("idle");
    expect(s.settleUntil).toBeDefined();
    expect(s.nextEligibleAt).toBe(s.settleUntil);
  });

  it("settle: stale `conflicting` on the freshly-pushed SHA does NOT re-fire within the window (budget preserved)", async () => {
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(1);
    fx.advance(AUTO_RESOLVE_SETTLE_MS - 1);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha2");
    await tick();
    expect(fx.cb.count).toBe(1);
    expect(fx.manager.get("s1")?.attemptCount).toBe(1);
    expect(fx.manager.get("s1")?.lastHeadSha).toBe("sha2");
  });

  it("settle: verdict that recomputes to mergeable within the window drops state (no spin)", async () => {
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    fx.advance(1000);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "mergeable" }), "main", "sha2");
    expect(fx.manager.get("s1")).toBeUndefined();
    expect(fx.cb.count).toBe(1);
  });

  it("settle: stale conflicting on the pushed head stays suppressed after the window", async () => {
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1", "base1");
    await tick();
    expect(fx.cb.count).toBe(1);
    fx.advance(AUTO_RESOLVE_SETTLE_MS - 1);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha2", "base1");
    await tick();
    expect(fx.cb.count).toBe(1);
    fx.advance(2);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha2", "base1");
    await tick();
    expect(fx.cb.count).toBe(1);
    expect(fx.manager.get("s1")?.attemptCount).toBe(1);
  });

  it("settle: a pushed head can retry when the base branch moved", async () => {
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1", "base1");
    await tick();
    expect(fx.cb.count).toBe(1);
    fx.advance(AUTO_RESOLVE_SETTLE_MS - 1);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha2", "base1");
    await tick();
    expect(fx.cb.count).toBe(1);
    fx.advance(2);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha2", "base2");
    await tick();
    expect(fx.cb.count).toBe(2);
  });

  it("settle: a genuinely-new external head outside the window still resets the budget", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "error", lastError: "boom", didWork: true })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.manager.get("s1")?.attemptCount).toBe(1);
    expect(fx.manager.get("s1")?.settleUntil).toBeUndefined();
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha2");
    await tick();
    expect(fx.manager.get("s1")?.attemptCount).toBe(1);
    expect(fx.manager.get("s1")?.lastHeadSha).toBe("sha2");
  });

  it("settle: resetForUserActivity clears the settle window", async () => {
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.manager.get("s1")?.settleUntil).toBeDefined();
    fx.manager.resetForUserActivity("s1");
    expect(fx.manager.get("s1")?.settleUntil).toBeUndefined();
    expect(fx.manager.get("s1")?.nextEligibleAt).toBeUndefined();
    expect(fx.manager.get("s1")?.attemptCount).toBe(0);
  });

  it("pendingReset: writeBack landing after a reset gives the user a fresh budget", async () => {
    let resolveCb: (r: AutoResolveResult) => void = () => { /* set below */ };
    fx = makeFixture({ cb: recordingCb(() => new Promise<AutoResolveResult>((r) => { resolveCb = r; })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.manager.get("s1")?.status).toBe("running");
    fx.manager.resetForUserActivity("s1");
    expect(fx.manager.get("s1")?.pendingReset).toBe(true);
    expect(fx.manager.get("s1")?.status).toBe("running");
    resolveCb({ outcome: "error", lastError: "boom", didWork: true });
    await tick();
    expect(fx.manager.get("s1")?.attemptCount).toBe(0);
    expect(fx.manager.get("s1")?.status).toBe("idle");
    expect(fx.manager.get("s1")?.lastError).toBeUndefined();
    expect(fx.manager.get("s1")?.pendingReset).toBeUndefined();
  });
});
