import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  AutoFixManager,
  autoFixResultForOutcome,
  AUTO_FIX_COOLDOWN_MS,
  AUTO_FIX_DEFERRED_COOLDOWN_MS,
  MAX_AUTO_FIX_ATTEMPTS,
  type AutoFixResult,
  type FetchAndFixCb,
} from "./auto-fix-manager.js";
import { turnDropped, turnInterrupted, TURN_STEERED } from "./turn-settlement.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { GraphQLPrNode } from "./pr-status-parser.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { RemediationArbiter } from "./auto-remediation-arbiter.js";

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

/**
 * Build a node whose rollup carries failed CHECK RUNS with real databaseIds, so
 * `extractFailedCheckRuns` returns a non-empty set (the dedup discriminator).
 * Each id becomes one FAILURE check run.
 *
 * `headRefOid` defaults to `oid` (the steady state — the rollup commit IS the
 * branch tip). Pass a distinct value to model the post-retrigger-push window
 * where `commits(last: 1)` (the failing rollup commit) lags behind the ref's
 * already-advanced tip (defect A — planning#64).
 */
function makeNodeWithChecks(oid: string, checkIds: number[], headRefOid = oid): GraphQLPrNode {
  return {
    headRefOid,
    commits: {
      nodes: [{
        commit: {
          oid,
          statusCheckRollup: {
            contexts: {
              nodes: checkIds.map((id) => ({
                databaseId: id,
                name: `job-${id}`,
                status: "COMPLETED",
                conclusion: "FAILURE",
                title: "failed",
              })),
            },
          },
        },
      }],
    },
  } as unknown as GraphQLPrNode;
}

interface RecordingCb extends FetchAndFixCb {
  count: () => number;
  /** The `failedChecks` array passed to the most recent invocation. */
  lastChecks: () => { databaseId: number }[];
  /** Just the databaseIds of the most recent invocation, for terse assertions. */
  lastIds: () => number[];
}

function recordingCb(outcome: () => AutoFixResult | Promise<AutoFixResult>): RecordingCb {
  let counter = 0;
  let last: { databaseId: number }[] = [];
  const cb: FetchAndFixCb = async (_s, _o, _r, failedChecks) => {
    counter++;
    last = failedChecks;
    return await outcome();
  };
  (cb as RecordingCb).count = () => counter;
  (cb as RecordingCb).lastChecks = () => last;
  (cb as RecordingCb).lastIds = () => last.map((c) => c.databaseId);
  return cb as RecordingCb;
}

function makeFixture(opts?: { enabled?: boolean; runner?: RunnerStub; cb?: RecordingCb; paused?: boolean; ensureRunner?: () => Promise<RunnerStub | undefined>; arbiter?: RemediationArbiter }) {
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
    opts?.arbiter,
    () => !paused, // docs/186 — per-session pause gate
    opts?.ensureRunner
      ? async () => await opts.ensureRunner!() as unknown as SessionRunnerInterface | undefined
      : undefined,
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
    failChecks: (checkIds: number[], oid = "sha1", headRefOid = oid) =>
      manager.handleTransition("s1", makeSummary("failure"), makeNodeWithChecks(oid, checkIds, headRefOid), "o", "r"),
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

  it("boots a runner server-side before firing when no viewer created one", async () => {
    const runner = makeRunner(false);
    let ensured = 0;
    fx = makeFixture({
      runner: undefined,
      ensureRunner: async () => { ensured++; return runner; },
    });
    fx.setRunner(undefined);

    await fx.fail();
    await tick();

    expect(ensured).toBe(1);
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

  // The `running` terminal trap. The resolved-signal cleanup used to sit BEHIND
  // the `status === "running"` short-circuit, and the ONLY other exit from
  // `running` is the post-turn write — so an attempt that never completed left
  // the card spinning on "Auto-fixing…" over a green CI forever, with the
  // arbiter claim held (which silently disables managed auto-merge and
  // auto-resolve for the session). Observed in production on PR #1904.
  it("a green-CI poll clears a state sitting in `running`", async () => {
    const cb = recordingCb(() => new Promise<AutoFixResult>(() => { /* never settles */ }));
    fx = makeFixture({ cb });

    await fx.fail();
    await tick();
    expect(fx.manager.get("s1")).toMatchObject({ status: "running" });

    await fx.transition("success");
    await tick();

    expect(fx.manager.get("s1")).toBeUndefined();
  });

  it("the abandoned attempt's terminal write releases the arbiter claim", async () => {
    const arbiter = new RemediationArbiter();
    let settle: (r: AutoFixResult) => void = () => { /* set below */ };
    const cb = recordingCb(() => new Promise<AutoFixResult>((r) => { settle = r; }));
    fx = makeFixture({ cb, arbiter });

    await fx.fail();
    await tick();
    expect(arbiter.isClaimed("s1")).toBe(true);

    // CI goes green while the fix turn is still in flight: the state goes...
    await fx.transition("success");
    await tick();
    expect(fx.manager.get("s1")).toBeUndefined();
    // ...but the claim is still held by the attempt that hasn't finished yet —
    // it is released by that attempt's own terminal path, not stolen here.
    expect(arbiter.isClaimed("s1")).toBe(true);

    settle({ outcome: "fixed" });
    await tick();
    expect(arbiter.isClaimed("s1")).toBe(false);
  });

  it("a green-CI poll also clears an `exhausted` state (the banner must not outlive the red CI)", async () => {
    for (let i = 0; i < MAX_AUTO_FIX_ATTEMPTS; i++) {
      await fx.fail();
      await tick();
      fx.advance(AUTO_FIX_COOLDOWN_MS + 1);
    }
    expect(fx.manager.get("s1")?.status).toBe("exhausted");

    await fx.transition("success");
    await tick();

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

  // ---- Stale-verdict dedup (the retrigger-push bug) ----------------------

  it("does NOT re-fire the same failed check runs after the cooldown (stale re-send)", async () => {
    // Attempt 1 sends runs {101, 102}.
    await fx.failChecks([101, 102]);
    await tick();
    expect(fx.cb.count()).toBe(1);

    // Cooldown elapses and GitHub still reports the SAME run (the retrigger
    // commit's checks haven't registered yet) — must NOT re-send.
    fx.advance(AUTO_FIX_COOLDOWN_MS + 1);
    await fx.failChecks([101, 102]);
    await tick();
    expect(fx.cb.count()).toBe(1);
  });

  it("DOES fire when a genuinely new run (new check-run IDs) appears", async () => {
    await fx.failChecks([101, 102]);
    await tick();
    expect(fx.cb.count()).toBe(1);

    // New head + new check-run databaseIds = a fresh verdict → fire.
    fx.advance(AUTO_FIX_COOLDOWN_MS + 1);
    await fx.failChecks([201], "sha2");
    await tick();
    expect(fx.cb.count()).toBe(2);
  });

  it("fires when any run is new but re-injects ONLY the new run (defect B — partial re-fire)", async () => {
    await fx.failChecks([101], "sha1");
    await tick();
    expect(fx.cb.count()).toBe(1);
    expect(fx.cb.lastIds()).toEqual([101]);

    // {101} already sent but {102} is new → the fire proceeds, but the payload is
    // trimmed to {102} only — the agent must NOT see {101}'s log a second time.
    fx.advance(AUTO_FIX_COOLDOWN_MS + 1);
    await fx.failChecks([101, 102], "sha1");
    await tick();
    expect(fx.cb.count()).toBe(2);
    expect(fx.cb.lastIds()).toEqual([102]);
  });

  it("does NOT fire a failure on a superseded run once the ref tip advances (defect A — planning#64)", async () => {
    // The current PR head has already advanced (headRefOid = sha2, e.g. an empty
    // retrigger commit whose run is queued/passing), but GitHub's commits(last:1)
    // still lags on the OLD failing commit (rollup oid = sha1) with its failed
    // check runs. That failure is for a superseded commit — it must NOT inject.
    await fx.failChecks([101, 102], "sha1", "sha2");
    await tick();
    expect(fx.cb.count()).toBe(0);
    // No fire ⇒ no auto-fix state was even created (suppressed like an ignore).
    expect(fx.manager.get("s1")).toBeUndefined();

    // Once the rollup catches up to the current tip (sha2) with a genuine
    // failure (rollup oid === headRefOid), the loop fires normally.
    await fx.failChecks([201], "sha2", "sha2");
    await tick();
    expect(fx.cb.count()).toBe(1);
    expect(fx.cb.lastIds()).toEqual([201]);
  });

  it("a noop attempt does NOT record check runs — the next poll retries them", async () => {
    fx = makeFixture({ cb: recordingCb(() => ({ outcome: "noop", lastError: "no_logs" })) });
    await fx.failChecks([101]);
    await tick();
    expect(fx.cb.count()).toBe(1);
    expect(fx.manager.get("s1")?.status).toBe("deferred");

    // Deferred cooldown elapses; same runs re-fire because the noop sent nothing.
    fx.advance(AUTO_FIX_DEFERRED_COOLDOWN_MS + 1);
    await fx.failChecks([101]);
    await tick();
    expect(fx.cb.count()).toBe(2);
  });

  // The 2026-08-10 duplicate-CI-fix incident (session 1cfb9c2c, PR #2127), at
  // this layer: the fix turn RAN and committed, its runner was then disposed
  // inside the post-turn window, and the settlement nets reported the finished
  // turn as `dropped`. `dropped` maps to "noop" — "couldn't even start" — so the
  // check run was never recorded as dispatched and the identical prompt with the
  // identical logs went out again on the next poll.
  //
  // `autoFixResultForOutcome` is the mapping that decides it; these pin both
  // sides of the line it draws.
  describe("settlement → accounting (autoFixResultForOutcome)", () => {
    it("a turn that RAN counts, whatever it settled as", () => {
      for (const status of ["completed", "errored", "no-result", "interrupted"] as const) {
        expect(autoFixResultForOutcome({ status, errored: status === "errored" }).outcome).toBe("fixed");
      }
    });

    it("only a turn that never ran is a noop", () => {
      expect(autoFixResultForOutcome(turnDropped("runner disposed mid-turn")).outcome).toBe("noop");
      expect(autoFixResultForOutcome(TURN_STEERED).outcome).toBe("noop");
    });
  });

  it("a fix turn cut short AFTER it ran never re-dispatches the same check run", async () => {
    // What the production settlement now reports for a completed turn whose
    // runner was disposed mid-teardown.
    fx = makeFixture({
      cb: recordingCb(() => autoFixResultForOutcome(
        turnInterrupted("runner disposed mid-turn — after the turn produced its result"),
      )),
    });
    await fx.failChecks([93522532864]);
    await tick();
    expect(fx.cb.count()).toBe(1);

    // The poll a minute later sees the identical still-red rollup: same head,
    // same check-run id, so the superseded guard (defect A) cannot help. The
    // dedup record is the only thing standing between it and a second send.
    fx.advance(AUTO_FIX_COOLDOWN_MS + 1);
    await fx.failChecks([93522532864]);
    await tick();
    expect(fx.cb.count()).toBe(1);
  });

  it("CI green forgets dispatched runs so a later identical-ID failure can fire", async () => {
    await fx.failChecks([101]);
    await tick();
    expect(fx.cb.count()).toBe(1);
    // Green drops state (and the dispatched set).
    await fx.transition("success");
    expect(fx.manager.get("s1")).toBeUndefined();
    // A fresh failure — even reusing the id — fires, because the set was cleared.
    await fx.failChecks([101]);
    await tick();
    expect(fx.cb.count()).toBe(2);
  });

  it("delete drops state", async () => {
    await fx.fail();
    await tick();
    expect(fx.manager.get("s1")).toBeDefined();
    fx.manager.delete("s1");
    expect(fx.manager.get("s1")).toBeUndefined();
  });
});
