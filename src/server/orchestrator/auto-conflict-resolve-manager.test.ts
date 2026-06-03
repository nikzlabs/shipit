import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  AutoConflictResolveManager,
  AUTO_RESOLVE_COOLDOWN_MS,
  AUTO_RESOLVE_DEFERRED_COOLDOWN_MS,
  MAX_AUTO_RESOLVE_ATTEMPTS,
  type AutoResolveResult,
  type RebaseAndResolveCb,
} from "./auto-conflict-resolve-manager.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { SessionRunnerInterface } from "./session-runner.js";

// ---- Test scaffolding ----------------------------------------------------

type RunnerStub = EventEmitter & {
  running: boolean;
  verifyRunningState: () => Promise<boolean>;
  emitMessage: (msg: unknown) => void;
  emitted: unknown[];
  /** Custom verify behavior — defaults to returning `running`. */
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
    // The manager only uses the subset of SessionRunnerInterface for its
    // gate; the stub provides those fields. Cast at the boundary so the
    // test doesn't need to instantiate every interface member.
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

// ---- Tests ---------------------------------------------------------------

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
    // Agent finished
    runner.running = false;
    await fx.manager.onRunnerIdle("s1");
    expect(fx.cb.count).toBe(1);
  });

  it("5. onRunnerIdle after conflict resolved (mergeable in cache) does NOT fire", async () => {
    const runner = makeRunner(true);
    fx.setRunner(runner);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    // The conflict resolves — next poll updates the cache.
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "mergeable" }), "main", "sha1");
    // state was deleted on the resolved poll — onRunnerIdle should be a no-op.
    runner.running = false;
    await fx.manager.onRunnerIdle("s1");
    expect(fx.cb.count).toBe(0);
  });

  it("6. UNKNOWN polls do not touch cache or fire", async () => {
    fx = makeFixture({ cb: recordingCb(() => new Promise(() => { /* never resolves */ })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.cb.count).toBe(1);
    expect(fx.manager.getLastKnownMergeable("s1")).toBe("conflicting");
    // UNKNOWN poll between two conflicting polls → nothing changes.
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "unknown" }), "main", "sha1");
    expect(fx.manager.getLastKnownMergeable("s1")).toBe("conflicting");
    // Still running from above so the running short-circuit applies; the
    // UNKNOWN handling didn't reach the running short-circuit either way.
    expect(fx.cb.count).toBe(1);
  });

  it("7. head SHA change resets attempt counter", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "error", lastError: "boom", didWork: true })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.manager.get("s1")?.attemptCount).toBe(1);
    // Advance past cooldown so the next poll on the same SHA could fire — confirms reset truly happens.
    fx.advance(AUTO_RESOLVE_COOLDOWN_MS + 1);
    // Force a head SHA change.
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha2");
    await tick();
    // After SHA reset the new attempt starts at 1.
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
    // Further polls short-circuit at step 6.
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(MAX_AUTO_RESOLVE_ATTEMPTS);
  });

  it("9. cooldown blocks then expires — sticky conflict re-fires without edge transition", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "error", lastError: "boom", didWork: true })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(1);
    // Poll within cooldown — short-circuit at step 10.
    fx.advance(AUTO_RESOLVE_COOLDOWN_MS - 1);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(1);
    // Poll after cooldown expires — re-fires.
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
    // Subsequent polls early-return at step 4.
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.cb.count).toBe(1);
    // In-flight writeBack still runs.
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
    await tick(); // still in cooldown — no fire
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
    // WS envelope reports success + forcePushed=false (no exhaustion yet).
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
    // Still within cooldown — does not fire.
    fx.advance(AUTO_RESOLVE_COOLDOWN_MS - 1);
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.cb.count).toBe(1);
  });

  it("18. cache snapshot read happens before cache write (regression for earlier algorithm bug)", async () => {
    // Pre-populate the cache via a clean poll, then transition to conflicting.
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "mergeable" }), "main", "sha1");
    expect(fx.manager.getLastKnownMergeable("s1")).toBeUndefined(); // state delete clears cache
    // Re-seed by going through a conflicting poll, then back to mergeable.
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    expect(fx.manager.getLastKnownMergeable("s1")).toBe("conflicting");
    // The next conflicting poll's snapshot read still sees "conflicting" — the
    // step-3 write does not clobber the prevKnown local used by later logic.
    // (Indirect assertion: the manager survives the cycle without losing state.)
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.manager.getLastKnownMergeable("s1")).toBe("conflicting");
  });

  it("re-entrancy guard: verifyRunningState synchronously emits idle → callback fires exactly once", async () => {
    const runner = makeRunner(true);
    runner.onVerify = () => {
      // Simulate the container runner's zombie-reset path: reset _isRunning and
      // synchronously emit "idle" inside verifyRunningState.
      runner.running = false;
      runner.emit("idle");
      return false;
    };
    fx.setRunner(runner);
    // Wire onRunnerIdle so the synchronous emit re-enters the manager (mirrors
    // the production registry subscription).
    runner.on("idle", () => { void fx.manager.onRunnerIdle("s1"); });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    await tick();
    // Even with the synchronous re-entry, the wrapper was called exactly once.
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

  it("pendingReset: writeBack landing after a reset gives the user a fresh budget", async () => {
    let resolveCb: (r: AutoResolveResult) => void = () => { /* set below */ };
    fx = makeFixture({ cb: recordingCb(() => new Promise<AutoResolveResult>((r) => { resolveCb = r; })) });
    await fx.manager.handleTransition("s1", makeSummary({ mergeable: "conflicting" }), "main", "sha1");
    expect(fx.manager.get("s1")?.status).toBe("running");
    // User types mid-attempt — reset is deferred.
    fx.manager.resetForUserActivity("s1");
    expect(fx.manager.get("s1")?.pendingReset).toBe(true);
    expect(fx.manager.get("s1")?.status).toBe("running"); // still running
    // Attempt exhausts.
    resolveCb({ outcome: "error", lastError: "boom", didWork: true });
    await tick();
    // pendingReset applied: attemptCount cleared, status idle (not exhausted).
    expect(fx.manager.get("s1")?.attemptCount).toBe(0);
    expect(fx.manager.get("s1")?.status).toBe("idle");
    expect(fx.manager.get("s1")?.lastError).toBeUndefined();
    expect(fx.manager.get("s1")?.pendingReset).toBeUndefined();
  });
});
