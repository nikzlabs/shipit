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
/** The run's prompt row and the agent's answer: what proves the prompt arrived. */
const ANSWERED: PersistedMessage[] = [
  { role: "user", text: SANDBOX_SPEC.prompt },
  { role: "assistant", text: "Looking at the open security PRs." },
];
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

  it("asks the worker of a run left without a runner by a restart, each time, instead of trusting the set", async () => {
    const working = new Set(["leftover"]);
    const probed: string[] = [];
    const live = new Set<string>();
    runner = makeRunner({
      liveWorkSessions: live,
      probeLiveWork: async (sessionId) => { probed.push(sessionId); return working.has(sessionId); },
    });
    const s = schedule();
    sessions.track("leftover", "Security PRs · Oct 6, 09:00");
    sessions.setScheduleRun("leftover", s.id, "earlier-run");
    live.add("leftover");

    await runner.runPass(at("2026-10-07T09:00:30Z"));
    expect(runs(s.id)[0]).toMatchObject({ outcome: "skipped" });
    working.delete("leftover");
    await runner.runPass(at("2026-10-08T09:00:30Z"));
    expect(runs(s.id)[0]).toMatchObject({ outcome: "started" });
    expect(probed).toEqual(["leftover", "leftover"]);
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

  it("is not cancelled by a pause while its session is prepared", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    runner = makeRunner({ startSession: (opts) => fakeStart(opts, () => held) });
    const s = schedule();
    const run = await runner.runNow(s.id);
    await flush();
    await runner.enqueue(s.id, () => store.update(s.id, { enabled: false }));
    release();
    await flush();
    expect(dispatched).toEqual(["session-1"]);
    expect(store.getRun(run.id)).toMatchObject({ outcome: "started" });
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

  it("marks a starting run whose prompt the agent answered as started", async () => {
    const { run } = leftover("starting", "s-told");
    chat.set("s-told", ANSWERED);
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

  it("sends the prompt again when only its row was saved: the row is written before the agent gets it", async () => {
    leftover("started", "s-saved");
    chat.set("s-saved", [
      { role: "user", text: SANDBOX_SPEC.prompt },
      { role: "assistant", text: "The agent didn't start on the first attempt — retrying…", notice: true },
    ]);
    await runner.runPass(NOW);
    expect(redispatches.map((r) => r.sessionId)).toEqual(["s-saved"]);
  });

  it("leaves a started run alone while its worker has not been probed", async () => {
    const { run } = leftover("started", "s-unknown");
    unprobed.add("s-unknown");
    await runner.runPass(NOW);
    expect(redispatches).toHaveLength(0);
    expect(store.getRun(run.id)?.outcome).toBe("started");
  });

  it("leaves a started run alone once its first turn has ended, or its prompt was delivered", async () => {
    const ended = leftover("started", "s-ended");
    sessions.setLastTurnOutcome("s-ended", "ok");
    const delivered = leftover("started", "s-delivered");
    chat.set("s-delivered", ANSWERED);
    await runner.runPass(NOW);
    expect(redispatches).toHaveLength(0);
    expect(store.getRun(ended.run.id)?.outcome).toBe("started");
    expect(store.getRun(delivered.run.id)?.outcome).toBe("started");
  });

  it("in local mode, fails a run the restart cut off, and still re-sends one never delivered", async () => {
    runner = makeRunner({ runtimeMode: "local" });
    const cutStarting = leftover("starting", "s-cut-1");
    chat.set("s-cut-1", ANSWERED);
    const cutStarted = leftover("started", "s-cut-2");
    chat.set("s-cut-2", ANSWERED);
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

describe("ScheduleRunner — finished runs (reqs 22, 31)", () => {
  async function startedRun(): Promise<{ scheduleId: string; runId: string; sessionId: string }> {
    const s = schedule();
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    sessions.setLastTurnOutcome("session-1", "ok");
    return { scheduleId: s.id, runId: runs(s.id)[0]!.id, sessionId: "session-1" };
  }

  it("saves a run as finished once nothing is left for the user, and keeps its result in the run row", async () => {
    const { runId, sessionId } = await startedRun();
    chat.set(sessionId, ANSWERED);
    events = [];
    expect(runner.decideRunFinished(sessionId)).toBe(true);
    expect(finishedAtOf(sessionId)).toEqual(expect.any(String));
    expect(store.getRun(runId)?.result).toBe("Looking at the open security PRs.");
    expect(events.map((e) => e.event)).toEqual(["schedule_run", "session_list"]);
    expect(runner.decideRunFinished(sessionId)).toBe(false);
  });

  it("decides nothing while the runner is busy", async () => {
    const { sessionId } = await startedRun();
    busy(sessionId);
    expect(runner.decideRunFinished(sessionId)).toBe(false);
    expect(finishedAtOf(sessionId)).toBeUndefined();
    registry.get(sessionId)!.endPostTurnWork();
    expect(runner.decideRunFinished(sessionId)).toBe(true);
  });

  it("is not finished after an error, while a question waits, a PR is open or a manual step shows; decided again each time", async () => {
    runner = makeRunner({ statusCardEnabled: () => true });
    const { sessionId } = await startedRun();
    sessions.setLastTurnOutcome(sessionId, "errored");
    runner.decideRunFinished(sessionId);
    expect(finishedAtOf(sessionId)).toBeUndefined();

    sessions.setLastTurnOutcome(sessionId, "ok");
    runner.decideRunFinished(sessionId);
    expect(finishedAtOf(sessionId)).toBeDefined();

    sessions.setPrStatus(sessionId, { prState: "open" } as never);
    expect(runner.decideRunFinished(sessionId)).toBe(true);
    expect(finishedAtOf(sessionId)).toBeUndefined();
    sessions.setPrStatus(sessionId, { prState: "merged" } as never);

    sessions.setAwaitingAnswer(sessionId, true);
    runner.decideRunFinished(sessionId);
    expect(finishedAtOf(sessionId)).toBeUndefined();
    sessions.setAwaitingAnswer(sessionId, false);

    sessions.setSessionStatus(sessionId, { status: "s", needsYou: ["Paste the token"], actions: [], fresh: true, writeSeq: 1, turnSeq: 1 } as never);
    runner.decideRunFinished(sessionId);
    expect(finishedAtOf(sessionId)).toBeUndefined();
    sessions.setSessionStatus(sessionId, null);
    runner.decideRunFinished(sessionId);
    expect(finishedAtOf(sessionId)).toBeDefined();
  });

  it("decides the session of a start that was called off, which no turn end would decide", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    runner = makeRunner({ startSession: (opts) => fakeStart(opts, () => held) });
    const s = schedule();
    const pass = runner.runPass(at("2026-10-07T09:00:30Z"));
    await flush();
    // Still starting: the session exists, but is not finished.
    expect(runner.decideRunFinished("session-1")).toBe(false);
    await runner.enqueue(s.id, () => store.update(s.id, { enabled: false }));
    release();
    await pass;
    expect(finishedAtOf("session-1")).toBeDefined();
  });
});

describe("ScheduleRunner — Stop (req 33)", () => {
  it("stops a running run: its turn is interrupted, automatic turns are held, and it is finished once it winds down", async () => {
    const interrupted: string[] = [];
    runner = makeRunner({ interruptTurn: (sessionId) => interrupted.push(sessionId) });
    const s = schedule();
    await runner.runPass(at("2026-10-07T09:00:30Z"));
    const [run] = runs(s.id);
    sessions.setPrStatus("session-1", { prState: "open" } as never);
    busy("session-1");

    await runner.stopRun(s.id, run!.id);
    expect(interrupted).toEqual(["session-1"]);
    expect(sessions.get("session-1")?.runStoppedAt).toEqual(expect.any(String));
    expect(sessions.automaticTurnsHeld("session-1")).toBe(true);
    expect(finishedAtOf("session-1")).toBeUndefined();
    expect(await runner.unfinishedRuns(s.id)).toEqual([
      { runId: run!.id, sessionId: "session-1", title: "Security PRs · Oct 7, 09:00", stopping: true },
    ]);

    registry.get("session-1")!.endPostTurnWork();
    runner.decideRunFinished("session-1");
    expect(finishedAtOf("session-1")).toBeDefined();
    expect(await runner.unfinishedRuns(s.id)).toEqual([]);

    // The user's next turn makes it active again (req 7).
    expect(sessions.reopenRun("session-1")).toBe(true);
    expect(sessions.automaticTurnsHeld("session-1")).toBe(false);
    expect(sessions.get("session-1")).not.toHaveProperty("runFinishedAt");
  });

  it("cancels a run still starting before its dispatch, without needing the user", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    runner = makeRunner({ startSession: (opts) => fakeStart(opts, () => held) });
    const s = schedule();
    const pass = runner.runPass(at("2026-10-07T09:00:30Z"));
    await flush();
    const [run] = runs(s.id);
    expect(await runner.unfinishedRuns(s.id)).toEqual([
      { runId: run!.id, sessionId: "session-1", title: "Security PRs · Oct 7, 09:00" },
    ]);

    expect(await runner.stopRun(s.id, run!.id)).toMatchObject({
      outcome: "failed",
      reason: "The run was stopped before it started.",
    });
    release();
    await pass;
    expect(dispatched).toHaveLength(0);
    expect(runs(s.id)[0]).toMatchObject({ outcome: "failed", reason: "The run was stopped before it started.", sessionId: "session-1" });
    expect(store.get(s.id)?.needsUserReason).toBeUndefined();
    expect(finishedAtOf("session-1")).toBeDefined();
    expect(await runner.unfinishedRuns(s.id)).toEqual([]);
  });

  it("finds a run whose schedule was deleted through its session, and refuses another schedule's run", async () => {
    sessions.track("orphan", "Gone · Oct 6, 09:00");
    sessions.setScheduleRun("orphan", "gone", "run-x");
    expect(await runner.stopRun("gone", "run-x")).toBeNull();
    expect(sessions.get("orphan")?.runStoppedAt).toBeDefined();
    await expect(runner.stopRun("other", "run-x")).rejects.toThrow("Run not found");
    await expect(runner.stopRun("gone", "run-y")).rejects.toThrow("Run not found");
  });

  it("does not send again, after a restart, the prompt of a run the user stopped", async () => {
    const s = schedule({}, "2026-10-07T09:00:00.000Z");
    const run = store.insertRun({ scheduleId: s.id, slotAt: at("2026-10-07T09:00:00Z"), spec: SANDBOX_SPEC, outcome: "started" })!;
    sessions.track("s-stopped", "Security PRs · Oct 7, 09:00");
    sessions.setScheduleRun("s-stopped", s.id, run.id);
    sessions.setRunStoppedAt("s-stopped", "2026-10-07T09:00:40.000Z");
    await runner.runPass(at("2026-10-07T09:01:00Z"));
    expect(redispatches.map((r) => r.sessionId)).toEqual(["s-stopped"]);
    expect(dispatched).toHaveLength(0);
    expect(store.getRun(run.id)?.outcome).toBe("started");
  });
});

describe("ScheduleRunner — Stop before the run's session exists (req 33)", () => {
  it("carries the stop to the session made afterwards, also when the schedule is deleted meanwhile", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    runner = makeRunner({
      startSession: async (opts) => {
        await held;
        return fakeStart(opts);
      },
    });
    const s = schedule();
    const pass = runner.runPass(at("2026-10-07T09:00:30Z"));
    await flush();
    const [run] = runs(s.id);
    await runner.stopRun(s.id, run!.id);
    // Delete no longer waits for it: the run is no longer starting, and has no session.
    expect(await runner.unfinishedRuns(s.id)).toEqual([]);
    store.delete(s.id);
    release();
    await pass;

    expect(dispatched).toHaveLength(0);
    expect(sessions.get("session-1")?.runStoppedAt).toEqual(expect.any(String));
    expect(sessions.automaticTurnsHeld("session-1")).toBe(true);
    expect(finishedAtOf("session-1")).toBeDefined();
  });
});

describe("ScheduleRunner — runs that are not finished (reqs 26, 32)", () => {
  it("lists runs still starting and runs not finished, archived ones too, and decides the others first", async () => {
    const s = schedule();
    const starting = store.insertRun({ scheduleId: s.id, slotAt: null, spec: SANDBOX_SPEC }, "2026-10-07T10:15:00.000Z")!;
    const link = (sessionId: string, title: string): void => {
      const run = store.insertRun({ scheduleId: s.id, slotAt: null, outcome: "started" })!;
      sessions.track(sessionId, title);
      sessions.setScheduleRun(sessionId, s.id, run.id);
      sessions.setLastTurnOutcome(sessionId, "ok");
    };
    link("errored", "Security PRs · Oct 5, 09:00");
    sessions.setLastTurnOutcome("errored", "quota-refused");
    sessions.archive("errored");
    link("undecided", "Security PRs · Oct 6, 09:00");

    expect(await runner.unfinishedRuns(s.id)).toEqual([
      { runId: sessions.get("errored")!.scheduleRunId!, sessionId: "errored", title: "Security PRs · Oct 5, 09:00", archived: true },
      { runId: starting.id, title: "Security PRs · Oct 7, 10:15" },
    ]);
    expect(sessions.get("undecided")?.runFinishedAt).toBeDefined();
  });
});

function finishedAtOf(sessionId: string): string | undefined {
  return sessions.get(sessionId)?.runFinishedAt;
}

describe("ScheduleRunner — runs that are not finished, from a stale or hidden state", () => {
  function linkedRun(sessionId: string): string {
    const s = schedule();
    const run = store.insertRun({ scheduleId: s.id, slotAt: null, outcome: "started" })!;
    sessions.track(sessionId, "Security PRs · Oct 7, 09:00");
    sessions.setScheduleRun(sessionId, s.id, run.id);
    sessions.setLastTurnOutcome(sessionId, "ok");
    return s.id;
  }

  it("asks the worker of a run left without a runner by a restart", async () => {
    let live = true;
    runner = makeRunner({ liveWorkSessions: new Set(["leftover"]), probeLiveWork: async () => live });
    const scheduleId = linkedRun("leftover");
    sessions.setRunFinishedAt("leftover", "2026-10-07T10:00:00.000Z");
    expect((await runner.unfinishedRuns(scheduleId)).map((r) => r.sessionId)).toEqual(["leftover"]);
    live = false;
    expect(await runner.unfinishedRuns(scheduleId)).toEqual([]);
  });

  it("decides a stored decision again, so a manual step shown since keeps the run", async () => {
    let cardOn = false;
    runner = makeRunner({ statusCardEnabled: () => cardOn });
    const scheduleId = linkedRun("with-step");
    sessions.setSessionStatus("with-step", { status: "s", needsYou: ["Paste the token"], actions: [], fresh: true, writeSeq: 1, turnSeq: 1 } as never);
    expect(await runner.unfinishedRuns(scheduleId)).toEqual([]);
    expect(finishedAtOf("with-step")).toBeDefined();

    cardOn = true;
    expect((await runner.unfinishedRuns(scheduleId)).map((r) => r.sessionId)).toEqual(["with-step"]);
    expect(finishedAtOf("with-step")).toBeUndefined();
  });

  it("counts a repository run's claimed session, which stays warm until its first dispatch", async () => {
    const scheduleId = linkedRun("claimed");
    db.db.prepare("UPDATE sessions SET warm = 1 WHERE id = ?").run("claimed");
    busy("claimed");
    expect((await runner.unfinishedRuns(scheduleId)).map((r) => r.sessionId)).toEqual(["claimed"]);
  });
});
