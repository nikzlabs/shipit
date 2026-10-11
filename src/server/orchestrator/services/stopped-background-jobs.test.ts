import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import type {
  SessionRunnerInterface,
  SessionRunnerRegistry,
  AgentDispatchOptions,
} from "../session-runner.js";
import {
  TURN_COMPLETED,
  createTurnSettlement,
  turnDropped,
  turnErrored,
  turnInterrupted,
  type TurnAdmission,
  type TurnHandle,
  type TurnOutcome,
} from "../turn-settlement.js";
import {
  buildStoppedBackgroundJobsPrompt,
  reportStoppedBackgroundJobs,
  type StoppedBackgroundJobsDeps,
} from "./stopped-background-jobs.js";

class FakeRunner {
  running = false;
  disposed = false;
  agentId = "claude" as const;
  subAgentSpawnsInFlight = 0;
  dispatched: AgentDispatchOptions[] = [];
  dispatchThrows: Error | null = null;
  admitAs: TurnAdmission = "started";
  emitted: { type: string }[] = [];
  chatMessageGroups = [];
  recordedCards = [];
  steeredMessages = [];
  lastPersistedBufferIndex = 0;
  constructor(public sessionDir: string) {}
  dispatch(opts: AgentDispatchOptions): TurnHandle {
    if (this.dispatchThrows) throw this.dispatchThrows;
    this.dispatched.push(opts);
    const settlement = createTurnSettlement();
    settlement.noteAdmission(this.admitAs);
    return settlement;
  }
  emitMessage(m: { type: string }): void { this.emitted.push(m); }
  getTurnEventBuffer(): unknown[] { return []; }
}

const JOBS = ["npm run build", "node scripts/render-models.js --all"];

function makeCtx() {
  const db = new DatabaseManager(":memory:");
  const sessionManager = new SessionManager(db);
  const chatHistoryManager = new ChatHistoryManager(db);
  const runners = new Map<string, FakeRunner>();
  const runnerRegistry = {
    get: (id: string) => runners.get(id) as unknown as SessionRunnerInterface | undefined,
    getOrCreate: (id: string, dir: string) => {
      let r = runners.get(id);
      if (!r) {
        r = new FakeRunner(dir);
        runners.set(id, r);
      }
      return r as unknown as SessionRunnerInterface;
    },
    dispose: (id: string) => { runners.delete(id); },
  } as unknown as SessionRunnerRegistry;

  sessionManager.track("s1", "Models", "/ws/s1");
  const runner = runnerRegistry.getOrCreate("s1", "/ws/s1", "claude") as unknown as FakeRunner;

  const deps: StoppedBackgroundJobsDeps = {
    sessionManager,
    runnerRegistry,
    chatHistoryManager,
    defaultAgentId: "claude",
  };
  const notices = (): string[] =>
    chatHistoryManager.load("s1").filter((m) => m.notice).map((m) => m.text);
  return { sessionManager, chatHistoryManager, runner, deps, notices };
}

describe("reportStoppedBackgroundJobs (docs/235 §9)", () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wakes the session with a system turn that names every stopped job", async () => {
    const decision = await reportStoppedBackgroundJobs(ctx.deps, { sessionId: "s1", jobs: JOBS, mayWake: true });

    expect(decision).toEqual({ woken: true, admitted: "started" });
    expect(ctx.runner.dispatched).toHaveLength(1);
    const dispatched = ctx.runner.dispatched[0];
    expect(dispatched.systemTurn).toBe(true);
    expect(dispatched.automatic).toBe(true);
    expect(dispatched.text).toBe(buildStoppedBackgroundJobsPrompt(JOBS));
    for (const job of JOBS) expect(dispatched.text).toContain(job);
    expect(ctx.sessionManager.get("s1")?.pendingAgentNotice).toBeUndefined();
  });

  it("reports a wake that queued behind another turn as queued", async () => {
    ctx.runner.admitAs = "queued";

    const decision = await reportStoppedBackgroundJobs(ctx.deps, { sessionId: "s1", jobs: JOBS, mayWake: true });

    expect(decision).toEqual({ woken: true, admitted: "queued" });
  });

  it("starts no second wake when the wake turn itself leaves jobs running", async () => {
    await reportStoppedBackgroundJobs(ctx.deps, { sessionId: "s1", jobs: JOBS, mayWake: true });
    const wakeDeliveryId = ctx.runner.dispatched[0].deliveryId;
    expect(wakeDeliveryId).toBeDefined();

    const again = ["npm run build"];
    const decision = await reportStoppedBackgroundJobs(ctx.deps, {
      sessionId: "s1",
      jobs: again,
      deliveryId: wakeDeliveryId,
      mayWake: true,
    });

    expect(decision).toEqual({ woken: false, reason: "own-wake" });
    expect(ctx.runner.dispatched).toHaveLength(1);
    expect(ctx.sessionManager.get("s1")?.pendingAgentNotice)
      .toBe(`[System] ${buildStoppedBackgroundJobsPrompt(again)}`);
    expect(ctx.notices()).toHaveLength(1);
    expect(ctx.notices()[0]).toContain("npm run build");
  });

  it("wakes again for a later turn that is not the wake", async () => {
    await reportStoppedBackgroundJobs(ctx.deps, { sessionId: "s1", jobs: JOBS, mayWake: true });

    const decision = await reportStoppedBackgroundJobs(ctx.deps, {
      sessionId: "s1",
      jobs: JOBS,
      deliveryId: "merge-watch:42",
      mayWake: true,
    });

    expect(decision.woken).toBe(true);
    expect(ctx.runner.dispatched).toHaveLength(2);
    expect(ctx.runner.dispatched[1].deliveryId).not.toBe(ctx.runner.dispatched[0].deliveryId);
  });

  it("leaves the note to the consult's own wake while a consult is in flight", async () => {
    ctx.runner.subAgentSpawnsInFlight = 1;

    const decision = await reportStoppedBackgroundJobs(ctx.deps, { sessionId: "s1", jobs: JOBS, mayWake: true });

    expect(decision).toEqual({ woken: false, reason: "consult-wake-delivers" });
    expect(ctx.runner.dispatched).toHaveLength(0);
    expect(ctx.sessionManager.get("s1")?.pendingAgentNotice)
      .toBe(`[System] ${buildStoppedBackgroundJobsPrompt(JOBS)}`);
    expect(ctx.notices()).toEqual([]);
  });

  it("starts no turn for a displaced process", async () => {
    const decision = await reportStoppedBackgroundJobs(ctx.deps, {
      sessionId: "s1",
      jobs: JOBS,
      mayWake: false,
    });

    expect(decision).toEqual({ woken: false, reason: "displaced" });
    expect(ctx.runner.dispatched).toHaveLength(0);
    expect(ctx.sessionManager.get("s1")?.pendingAgentNotice)
      .toBe(`[System] ${buildStoppedBackgroundJobsPrompt(JOBS)}`);
    expect(ctx.notices()).toHaveLength(1);
  });

  it("parks the note and tells the user when the wake cannot be dispatched", async () => {
    ctx.runner.dispatchThrows = new Error("container could not be resumed");

    const decision = await reportStoppedBackgroundJobs(ctx.deps, { sessionId: "s1", jobs: JOBS, mayWake: true });

    expect(decision).toEqual({ woken: false, reason: "wake-failed" });
    expect(ctx.sessionManager.get("s1")?.pendingAgentNotice)
      .toBe(`[System] ${buildStoppedBackgroundJobsPrompt(JOBS)}`);
    expect(ctx.notices()).toHaveLength(1);
    expect(ctx.notices()[0]).toContain("container could not be resumed");
  });

  function settleWakeAs(outcome: TurnOutcome): void {
    vi.spyOn(ctx.runner, "dispatch").mockImplementation((opts: AgentDispatchOptions) => {
      const settlement = createTurnSettlement();
      settlement.noteAdmission("started");
      opts.onTurnComplete?.(outcome);
      return settlement;
    });
  }

  // A plain `errored` too: env preparation can fail after the dispatch was admitted.
  it.each([
    ["dropped", turnDropped("runner disposed mid-turn")],
    ["errored", turnErrored()],
  ])("parks the note when the wake turn ends as %s", async (_name, outcome) => {
    settleWakeAs(outcome);

    const decision = await reportStoppedBackgroundJobs(ctx.deps, { sessionId: "s1", jobs: JOBS, mayWake: true });

    expect(decision.woken).toBe(true);
    expect(ctx.sessionManager.get("s1")?.pendingAgentNotice)
      .toBe(`[System] ${buildStoppedBackgroundJobsPrompt(JOBS)}`);
  });

  it.each([
    ["completed", TURN_COMPLETED],
    ["interrupted", turnInterrupted("the user stopped it")],
  ])("parks nothing when the wake turn ends as %s", async (_name, outcome) => {
    settleWakeAs(outcome);

    await reportStoppedBackgroundJobs(ctx.deps, { sessionId: "s1", jobs: JOBS, mayWake: true });

    expect(ctx.sessionManager.get("s1")?.pendingAgentNotice).toBeUndefined();
  });

  it("does nothing for an archived session", async () => {
    ctx.sessionManager.archive("s1");

    const decision = await reportStoppedBackgroundJobs(ctx.deps, { sessionId: "s1", jobs: JOBS, mayWake: true });

    expect(decision).toEqual({ woken: false, reason: "no-session" });
    expect(ctx.runner.dispatched).toHaveLength(0);
  });

  it("does nothing with no jobs", async () => {
    const decision = await reportStoppedBackgroundJobs(ctx.deps, { sessionId: "s1", jobs: [], mayWake: true });

    expect(decision).toEqual({ woken: false, reason: "no-jobs" });
    expect(ctx.runner.dispatched).toHaveLength(0);
  });

  it("shortens a long job list in the prompt", () => {
    const many = Array.from({ length: 14 }, (_, i) => `job-${i} ${"x".repeat(400)}`);

    const prompt = buildStoppedBackgroundJobsPrompt(many);

    expect(prompt).toContain("job-9 ");
    expect(prompt).not.toContain("job-10 ");
    expect(prompt).toContain("and 4 more");
    expect(prompt).not.toContain("x".repeat(301));
    expect(prompt).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });
});
