import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ScheduleStore, type NewSchedule } from "./schedule-store.js";
import { ScheduleRunner, type ScheduleRunnerDeps } from "./schedule-runner.js";
import { DISPATCH_SETUP_FAILURE, SessionRunnerRegistry } from "./session-runner.js";
import { createTurnSettlement, turnErrored, type TurnHandle } from "./turn-settlement.js";
import type { CreateHeadlessSessionOptions, RedispatchOptions } from "./services/headless-sessions.js";
import type { PersistedMessage } from "./chat-history.js";
import type { CredentialStore } from "./credential-store.js";
import type { ScheduleRun } from "../shared/types.js";
import { ServiceError } from "./services/types.js";

const REPO = "https://github.com/o/r";
const SANDBOX_SPEC = {
  target: { kind: "sandbox", capabilities: { git: false, docker: false, network: true, dangerousGitHubOps: false } },
  params: {},
  prompt: "Check current security PRs and merge them.",
};
const at = (iso: string) => new Date(iso);
const OCT_7_0800 = "2026-10-07T08:00:00.000Z";

let db: DatabaseManager;
let store: ScheduleStore;
let sessions: SessionManager;
let registry: SessionRunnerRegistry;
let chat: Map<string, PersistedMessage[]>;
let events: { event: string; data: unknown }[];
let starts: CreateHeadlessSessionOptions[];
let dispatched: string[];
let redispatches: { sessionId: string; opts: RedispatchOptions }[];
let turns: Map<string, ReturnType<typeof createTurnSettlement>>;
let unprobed: Set<string>;
let trusted: boolean;
let counter: number;
let runner: ScheduleRunner;

/** Creates and links the run's session as `createHeadlessSession` does, then goes through the gate. */
async function fakeStart(opts: CreateHeadlessSessionOptions, beforeGate?: () => Promise<void>): Promise<unknown> {
  starts.push(opts);
  const sessionId = `session-${++counter}`;
  sessions.track(sessionId, opts.title);
  sessions.setScheduleRun(sessionId, opts.scheduleRun!.scheduleId, opts.scheduleRun!.runId);
  await beforeGate?.();
  const turn = createTurnSettlement();
  await opts.dispatchGate!(sessionId, () => {
    dispatched.push(sessionId);
    turns.set(sessionId, turn);
    return turn;
  });
  return { sessionId };
}

function makeRunner(over: Partial<ScheduleRunnerDeps> = {}): ScheduleRunner {
  return new ScheduleRunner({
    store,
    sessionManager: sessions,
    runnerRegistry: registry,
    chatHistoryManager: { load: (id: string) => chat.get(id) ?? [] },
    repoStore: { get: (url: string) => (url === REPO ? ({ url } as never) : undefined), isTrusted: () => trusted },
    credentialStore: { listSshHosts: () => [] } as unknown as CredentialStore,
    runtimeMode: "containerized",
    sseBroadcast: (event, data) => events.push({ event, data }),
    startSession: (opts) => fakeStart(opts),
    redispatch: async (sessionId: string, opts: RedispatchOptions): Promise<TurnHandle> => {
      redispatches.push({ sessionId, opts });
      const turn = createTurnSettlement();
      return opts.dispatchGate!(sessionId, () => {
        dispatched.push(sessionId);
        turns.set(sessionId, turn);
        return turn;
      });
    },
    unprobedSessions: unprobed,
    ...over,
  });
}

function schedule(over: Partial<NewSchedule> = {}, activeSince = OCT_7_0800) {
  return store.create({
    name: "Security PRs",
    timing: { kind: "daily", hour: 9, minute: 0 },
    timeZone: "UTC",
    spec: SANDBOX_SPEC,
    ...over,
  }, activeSince);
}

function busy(sessionId: string): void {
  registry.getOrCreate(sessionId, `/tmp/${sessionId}`, "claude").beginPostTurnWork();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

const runs = (scheduleId: string): ScheduleRun[] => store.listRuns(scheduleId);
const runEvents = () => events.filter((e) => e.event === "schedule_run").map((e) => (e.data as { run: ScheduleRun }).run);

beforeEach(() => {
  db = new DatabaseManager(":memory:");
  store = new ScheduleStore(db);
  sessions = new SessionManager(db);
  registry = new SessionRunnerRegistry();
  chat = new Map();
  events = [];
  starts = [];
  dispatched = [];
  redispatches = [];
  turns = new Map();
  unprobed = new Set();
  trusted = true;
  counter = 0;
  runner = makeRunner();
});

afterEach(() => {
  runner.stop();
  registry.disposeAll();
  db.close();
});

describe("ScheduleRunner — due runs", () => {
  it("starts a due slot once, from the run's own copy of the spec (reqs 1, 2)", async () => {
    const s = schedule();
    await runner.runPass(at("2026-10-07T08:59:00Z"));
    expect(starts).toHaveLength(0);

    await runner.runPass(at("2026-10-07T09:00:30Z"));
    expect(starts).toHaveLength(1);
    const [run] = runs(s.id);
    expect(starts[0]).toEqual({
      target: SANDBOX_SPEC.target,
      params: {},
      prompt: SANDBOX_SPEC.prompt,
      title: "Security PRs · Oct 7, 09:00",
      deliveryId: run!.id,
      fetchBase: true,
      scheduleRun: { scheduleId: s.id, runId: run!.id },
      dispatchGate: expect.any(Function),
    });
    expect(run).toMatchObject({
      slotAt: "2026-10-07T09:00:00.000Z",
      outcome: "started",
      sessionId: "session-1",
      startedAt: expect.any(String),
      spec: SANDBOX_SPEC,
    });
    expect(runEvents().map((r) => r.outcome)).toEqual(["starting", "started"]);

    await runner.runPass(at("2026-10-07T09:10:00Z"));
    expect(starts).toHaveLength(1);
  });

  it("starts a slot once when passes are asked for at the same time", async () => {
    const s = schedule();
    const now = at("2026-10-07T09:00:30Z");
    await Promise.all([runner.runPass(now), runner.runPass(now), runner.runPass(now)]);
    expect(starts).toHaveLength(1);
    expect(runs(s.id)).toHaveLength(1);
  });

  it("starts a slot once when two schedulers share the database", async () => {
    const s = schedule();
    const other = makeRunner();
    const now = at("2026-10-07T09:00:30Z");
    await Promise.all([runner.runPass(now), other.runPass(now)]);
    expect(starts).toHaveLength(1);
    expect(runs(s.id)).toHaveLength(1);
    other.stop();
  });

  it("after downtime, runs only the latest slot and records the missed ones as one skipped row (req 15)", async () => {
    const s = schedule({}, "2026-10-04T08:00:00.000Z");
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    expect(starts).toHaveLength(1);
    expect(runs(s.id).map((r) => [r.outcome, r.slotAt, r.reason])).toEqual([
      ["started", "2026-10-07T09:00:00.000Z", undefined],
      ["skipped", "2026-10-06T09:00:00.000Z", "3 runs missed between 2026-10-04 09:00 and 2026-10-06 09:00 (UTC)."],
    ]);
    // The 09:00 slot of the next day still runs on time (req 17).
    await runner.runPass(at("2026-10-08T09:00:05Z"));
    expect(starts).toHaveLength(2);
  });

  it("skips a slot while the previous run is still going, and records why (req 14)", async () => {
    const s = schedule();
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    busy("session-1");

    await runner.runPass(at("2026-10-08T09:00:30Z"));
    expect(starts).toHaveLength(1);
    expect(runs(s.id)[0]).toMatchObject({
      outcome: "skipped",
      slotAt: "2026-10-08T09:00:00.000Z",
      reason: 'The previous run, "Security PRs · Oct 7, 09:00", was still going.',
    });

    registry.get("session-1")!.endPostTurnWork();
    await runner.runPass(at("2026-10-09T09:00:30Z"));
    expect(starts).toHaveLength(2);
  });

  it("does not count a run that waits for the user's answer as still going (req 23)", async () => {
    schedule();
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    busy("session-1");
    sessions.setAwaitingAnswer("session-1", true);

    await runner.runPass(at("2026-10-08T09:00:30Z"));
    expect(starts).toHaveLength(2);
  });

  it("counts a run still being started, and an unprobed run after a restart, as still going", async () => {
    const s = schedule();
    // The first pass would recover a starting row left by a restart.
    await runner.runPass(at("2026-10-07T08:30:00Z"));
    store.insertRun({ scheduleId: s.id, slotAt: null, spec: SANDBOX_SPEC });
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    expect(runs(s.id)[0]).toMatchObject({ outcome: "skipped", reason: "The previous run was still starting." });

    const t = schedule({ name: "Other" });
    sessions.track("leftover", "Other · Oct 6, 09:00");
    sessions.setScheduleRun("leftover", t.id, "earlier-run");
    unprobed.add("leftover");
    await runner.runPass(at("2026-10-07T09:01:00Z"));
    expect(runs(t.id)[0]).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("was still going") });
  });

  it("starts due runs one at a time", async () => {
    schedule({ name: "A" });
    schedule({ name: "B" });
    let active = 0;
    let most = 0;
    runner = makeRunner({
      startSession: (opts) => fakeStart(opts, async () => {
        active += 1;
        most = Math.max(most, active);
        await flush();
        active -= 1;
      }),
    });
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    expect(starts.map((o) => o.title)).toEqual(["A · Oct 7, 09:00", "B · Oct 7, 09:00"]);
    expect(most).toBe(1);
  });

  it("starts nothing for a paused schedule", async () => {
    const s = schedule({ enabled: false });
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    expect(starts).toHaveLength(0);
    expect(runs(s.id)).toHaveLength(0);
  });

  it("runs the changes of one schedule one at a time, and a failed one does not stop the next", async () => {
    const order: string[] = [];
    const first = runner.enqueue("s", async () => { await flush(); order.push("first"); });
    const second = runner.enqueue("s", () => { order.push("second"); throw new Error("boom"); });
    const third = runner.enqueue("s", () => { order.push("third"); return 3; });
    await first;
    await expect(second).rejects.toThrow("boom");
    expect(await third).toBe(3);
    expect(order).toEqual(["first", "second", "third"]);
  });
});

describe("ScheduleRunner — Run now (req 26)", () => {
  it("starts at once, past a running run and on a paused schedule", async () => {
    const s = schedule();
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    busy("session-1");
    store.update(s.id, { enabled: false });

    const run = await runner.runNow(s.id);
    expect(run).toMatchObject({ slotAt: null, outcome: "starting" });
    await flush();
    const second = await runner.runNow(s.id);
    await flush();
    expect(starts).toHaveLength(3);
    expect(store.getRun(run.id)).toMatchObject({ outcome: "started", sessionId: "session-2" });
    expect(store.getRun(second.id)).toMatchObject({ outcome: "started", sessionId: "session-3" });
  });

  it("refuses a schedule that does not exist", async () => {
    await expect(runner.runNow("missing")).rejects.toThrow("Schedule not found");
  });
});

describe("ScheduleRunner — failed starts (req 18)", () => {
  it("fails the run on a pre-flight problem, marks the schedule, and the next start clears it", async () => {
    const elsewhere = { ...SANDBOX_SPEC, target: { kind: "repo", repoUrl: "https://github.com/o/gone" } };
    const s = schedule({ spec: elsewhere });
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    expect(starts).toHaveLength(0);
    const reason = "The repository https://github.com/o/gone is not added to ShipIt.";
    expect(runs(s.id)[0]).toMatchObject({ outcome: "failed", reason });
    expect(store.get(s.id)?.needsUserReason).toBe(reason);
    expect(events.some((e) => e.event === "schedules")).toBe(true);

    store.update(s.id, { spec: { ...SANDBOX_SPEC, target: { kind: "repo", repoUrl: REPO } } });
    await runner.runPass(at("2026-10-08T09:00:30Z"));
    expect(starts).toHaveLength(1);
    expect(store.get(s.id)?.needsUserReason).toBeUndefined();
  });

  it("fails the run of an untrusted repository", async () => {
    trusted = false;
    const s = schedule({ spec: { ...SANDBOX_SPEC, target: { kind: "repo", repoUrl: REPO } } });
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    expect(runs(s.id)[0]).toMatchObject({ outcome: "failed", reason: expect.stringContaining("is not trusted") });
  });

  it("fails the run of a spec that no longer reads", async () => {
    const s = schedule({ spec: { target: { kind: "nowhere" } } });
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    expect(runs(s.id)[0]).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("The schedule's session description no longer reads"),
    });
  });

  it("keeps the session linked when the start is refused after the session exists", async () => {
    runner = makeRunner({
      startSession: async (opts) => {
        sessions.track("half-made", opts.title);
        sessions.setScheduleRun("half-made", opts.scheduleRun!.scheduleId, opts.scheduleRun!.runId);
        throw new ServiceError(503, "This session's container did not start, so its settings could not be applied.");
      },
    });
    const s = schedule();
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    expect(runs(s.id)[0]).toMatchObject({
      outcome: "failed",
      sessionId: "half-made",
      reason: "This session's container did not start, so its settings could not be applied.",
    });
    expect(store.get(s.id)?.needsUserReason).toContain("container did not start");
  });

  it("cancels the start before its dispatch when the schedule is paused meanwhile, without needing the user", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    runner = makeRunner({ startSession: (opts) => fakeStart(opts, () => held) });
    const s = schedule();
    const pass = runner.runPass(at("2026-10-07T09:00:30Z"));
    await flush();
    await runner.enqueue(s.id, () => store.update(s.id, { enabled: false }));
    release();
    await pass;

    expect(dispatched).toHaveLength(0);
    expect(runs(s.id)[0]).toMatchObject({
      outcome: "failed",
      reason: "The schedule was paused before the run started.",
      sessionId: "session-1",
    });
    expect(store.get(s.id)?.needsUserReason).toBeUndefined();
  });

  it("cancels the start of a schedule deleted meanwhile; the session keeps its schedule id", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    runner = makeRunner({ startSession: (opts) => fakeStart(opts, () => held) });
    const s = schedule();
    const pass = runner.runPass(at("2026-10-07T09:00:30Z"));
    await flush();
    await runner.enqueue(s.id, () => store.delete(s.id));
    release();
    await pass;
    expect(dispatched).toHaveLength(0);
    expect(sessions.get("session-1")?.scheduleId).toBe(s.id);
  });

  it("fails the run when its dispatch fails during setup", async () => {
    const s = schedule();
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    turns.get("session-1")!.settle(turnErrored(`${DISPATCH_SETUP_FAILURE}: the worker never answered`));
    await flush();
    expect(runs(s.id)[0]).toMatchObject({ outcome: "failed", reason: "the worker never answered" });
    expect(store.get(s.id)?.needsUserReason).toBe("the worker never answered");
  });

  it("fails the run when its first turn is refused for quota, but not for a later turn's refusal", async () => {
    const s = schedule();
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    runner.noteTurnEnd({
      sessionId: "session-1", outcome: "quota-refused", submitted: true, first: true, detail: "You've hit your limit",
    });
    expect(runs(s.id)[0]).toMatchObject({
      outcome: "failed",
      reason: "The agent's account is out of quota: You've hit your limit",
      sessionId: "session-1",
    });

    await runner.runPass(at("2026-10-08T09:00:30Z"));
    runner.noteTurnEnd({ sessionId: "session-2", outcome: "ok", submitted: true, first: true });
    runner.noteTurnEnd({ sessionId: "session-2", outcome: "quota-refused", submitted: true, first: false });
    expect(runs(s.id)[0]).toMatchObject({ outcome: "started", sessionId: "session-2" });
  });

  it("fails the run when its first turn errored before reaching the agent, not after", async () => {
    const s = schedule();
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    runner.noteTurnEnd({ sessionId: "session-1", outcome: "errored", submitted: true, first: true, detail: "crashed mid-way" });
    expect(runs(s.id)[0]).toMatchObject({ outcome: "started" });

    await runner.runPass(at("2026-10-08T09:00:30Z"));
    runner.noteTurnEnd({
      sessionId: "session-2", outcome: "errored", submitted: false, first: true, detail: "No eligible account.",
    });
    expect(runs(s.id)[0]).toMatchObject({ outcome: "failed", reason: "No eligible account." });
  });
});

describe("ScheduleRunner — recovery after a restart", () => {
  const NOW = at("2026-10-07T09:01:00Z");

  function leftover(outcome: "starting" | "started", sessionId?: string) {
    const s = schedule({}, "2026-10-07T09:00:00.000Z");
    const run = store.insertRun({ scheduleId: s.id, slotAt: at("2026-10-07T09:00:00Z"), spec: SANDBOX_SPEC, outcome })!;
    if (sessionId) {
      sessions.track(sessionId, "Security PRs · Oct 7, 09:00");
      sessions.setScheduleRun(sessionId, s.id, run.id);
    }
    return { s, run };
  }

  it("starts a starting run that has no session yet, from the row's spec", async () => {
    const { run } = leftover("starting");
    await runner.runPass(NOW);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ deliveryId: run.id, prompt: SANDBOX_SPEC.prompt });
    expect(store.getRun(run.id)).toMatchObject({ outcome: "started", sessionId: "session-1" });
  });

  it("marks a starting run whose prompt reached its runner as started, without starting it again", async () => {
    const { run } = leftover("starting", "s-live");
    registry.getOrCreate("s-live", "/tmp/s-live", "claude").activeDeliveryId = run.id;
    await runner.runPass(NOW);
    expect(starts).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    expect(store.getRun(run.id)).toMatchObject({ outcome: "started", sessionId: "s-live" });
  });

  it("marks a starting run whose prompt is in its chat history as started", async () => {
    const { run } = leftover("starting", "s-told");
    chat.set("s-told", [{ role: "user", text: SANDBOX_SPEC.prompt }]);
    await runner.runPass(NOW);
    expect(starts).toHaveLength(0);
    expect(store.getRun(run.id)).toMatchObject({ outcome: "started", sessionId: "s-told" });
  });

  it("fails a starting run whose session was still being prepared, and links the session", async () => {
    const { s, run } = leftover("starting", "s-half");
    await runner.runPass(NOW);
    expect(starts).toHaveLength(0);
    expect(store.getRun(run.id)).toMatchObject({
      outcome: "failed",
      sessionId: "s-half",
      reason: "ShipIt restarted while this run's session was being prepared.",
    });
    expect(store.get(s.id)?.needsUserReason).toBeDefined();
  });

  it("sends the prompt again into a started run whose dispatch never arrived, and watches its first turn", async () => {
    const { run } = leftover("started", "s-lost");
    await runner.runPass(NOW);
    expect(redispatches).toEqual([{
      sessionId: "s-lost",
      opts: { params: {}, prompt: SANDBOX_SPEC.prompt, deliveryId: run.id, dispatchGate: expect.any(Function) },
    }]);
    expect(dispatched).toEqual(["s-lost"]);
    runner.noteTurnEnd({ sessionId: "s-lost", outcome: "quota-refused", submitted: true, first: true });
    expect(store.getRun(run.id)).toMatchObject({ outcome: "failed" });
  });

  it("leaves a started run alone once its first turn has ended, or its prompt was delivered", async () => {
    const ended = leftover("started", "s-ended");
    sessions.setLastTurnOutcome("s-ended", "ok");
    const delivered = leftover("started", "s-delivered");
    chat.set("s-delivered", [{ role: "user", text: SANDBOX_SPEC.prompt }]);
    await runner.runPass(NOW);
    expect(redispatches).toHaveLength(0);
    expect(store.getRun(ended.run.id)?.outcome).toBe("started");
    expect(store.getRun(delivered.run.id)?.outcome).toBe("started");
  });

  it("in local mode, fails a run the restart cut off, and still re-sends one never delivered", async () => {
    runner = makeRunner({ runtimeMode: "local" });
    const cutStarting = leftover("starting", "s-cut-1");
    chat.set("s-cut-1", [{ role: "user", text: SANDBOX_SPEC.prompt }]);
    const cutStarted = leftover("started", "s-cut-2");
    chat.set("s-cut-2", [{ role: "user", text: SANDBOX_SPEC.prompt }]);
    const lost = leftover("started", "s-lost");
    await runner.runPass(NOW);
    expect(store.getRun(cutStarting.run.id)).toMatchObject({ outcome: "failed", reason: "ShipIt restarted during the run." });
    expect(store.getRun(cutStarted.run.id)).toMatchObject({ outcome: "failed", reason: "ShipIt restarted during the run." });
    expect(store.getRun(lost.run.id)?.outcome).toBe("started");
    expect(redispatches.map((r) => r.sessionId)).toEqual(["s-lost"]);
  });

  it("restores the first-turn watch for a turn adopted after the restart", async () => {
    const { run } = leftover("started", "s-adopted");
    sessions.setLastTurnOutcome("s-adopted", "ok");
    expect(runner.rebindDelivery("not-a-run")).toBeUndefined();
    const settle = runner.rebindDelivery(run.id);
    expect(settle).toBeTypeOf("function");
    settle!(turnErrored(`${DISPATCH_SETUP_FAILURE}: lost`));
    expect(store.getRun(run.id)).toMatchObject({ outcome: "failed", reason: "lost" });
  });
});
