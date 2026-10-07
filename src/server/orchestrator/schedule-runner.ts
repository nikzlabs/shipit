import type { ScheduleStore } from "./schedule-store.js";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { RuntimeMode } from "./app-di.js";
import type { CreateHeadlessSessionOptions, RedispatchOptions } from "./services/headless-sessions.js";
import type { TurnEnd, TurnHandle, TurnOutcome } from "./turn-settlement.js";
import type { DueSlots } from "../shared/schedule-timing.js";
import type { Schedule, ScheduleRun } from "../shared/types.js";
import { DISPATCH_SETUP_FAILURE } from "./session-runner.js";
import { dueSlots, formatInZone } from "../shared/schedule-timing.js";
import { parseSessionStartSpec } from "../shared/session-start-spec.js";
import { scheduleSpecProblem, toScheduleView, type ScheduleQueue, type ScheduleSpecDeps } from "./services/schedules.js";
import { ServiceError } from "./services/types.js";
import { getErrorMessage } from "./validation.js";

/**
 * docs/324-scheduled-sessions → The scheduler: starts due runs through the headless
 * session start (reqs 1, 2, 14–18, 23, 26, 29). A run row is the claim of its slot, so
 * every decision here can be read back from the database after a restart.
 */

export const SCHEDULE_PASS_INTERVAL_MS = 30_000;

const RESTARTED_DURING_RUN = "ShipIt restarted during the run.";
const RESTARTED_WHILE_PREPARING = "ShipIt restarted while this run's session was being prepared.";

export interface ScheduleRunnerDeps extends ScheduleSpecDeps {
  store: ScheduleStore;
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  chatHistoryManager: Pick<ChatHistoryManager, "load">;
  runtimeMode: RuntimeMode;
  sseBroadcast: (event: string, data: unknown) => void;
  /** The headless session start (`createHeadlessSession`). */
  startSession: (opts: CreateHeadlessSessionOptions) => Promise<unknown>;
  /** Sends a run's prompt again into its session (`redispatchHeadlessPrompt`). */
  redispatch: (sessionId: string, opts: RedispatchOptions) => Promise<TurnHandle>;
  /** Sessions whose worker no probe reached after a restart; any of them may still be working. */
  unprobedSessions?: ReadonlySet<string>;
}

/** The start was called off by a change the user made: no reason to show as needing them. */
class StartCancelled extends Error {}

function missedReason(missed: NonNullable<DueSlots["missed"]>, timeZone: string): string {
  const first = formatInZone(missed.first, timeZone);
  if (missed.count === 1) return `1 run missed, at ${first} (${timeZone}).`;
  return `${missed.count} runs missed between ${first} and ${formatInZone(missed.last, timeZone)} (${timeZone}).`;
}

/** "*schedule name* · *date*"; a Run now run is named by when it starts. */
function runTitle(schedule: Schedule, run: ScheduleRun): string {
  const at = new Date(run.slotAt ?? Date.now());
  const when = at.toLocaleString("en-US", {
    timeZone: schedule.timeZone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${schedule.name} · ${when}`;
}

/** A first turn that failed this way never got to the run's work (req 18). */
function firstTurnFailure(end: TurnEnd): string | null {
  if (end.outcome === "quota-refused") {
    return `The agent's account is out of quota${end.detail ? `: ${end.detail}` : "."}`;
  }
  if (end.outcome === "errored" && !end.submitted) return end.detail ?? "The run's first turn could not start.";
  return null;
}

export class ScheduleRunner implements ScheduleQueue {
  private readonly queues = new Map<string, Promise<unknown>>();
  private pass: Promise<void> | null = null;
  private recovered = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly deps: ScheduleRunnerDeps) {}

  /** The startup pass, which also recovers what a restart cut off, and then one every 30 seconds. */
  start(opts: { interval: boolean }): void {
    this.tick();
    if (!opts.interval || this.timer) return;
    this.timer = setInterval(() => this.tick(), SCHEDULE_PASS_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One queue per schedule: every start and every change of the schedule runs here, one
   * at a time. A failed step does not stop the ones queued behind it.
   */
  enqueue<T>(scheduleId: string, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(scheduleId) ?? Promise.resolve();
    const result = (async () => {
      await previous;
      return fn();
    })();
    const tail = result.catch(() => undefined);
    this.queues.set(scheduleId, tail);
    void tail.finally(() => {
      if (this.queues.get(scheduleId) === tail) this.queues.delete(scheduleId);
    });
    return result;
  }

  /** Waits for a pass in flight, then runs one: two passes never overlap. */
  async runPass(now?: Date): Promise<void> {
    while (this.pass) await this.pass;
    const pass = this.passOnce(now);
    this.pass = pass;
    try {
      await pass;
    } finally {
      if (this.pass === pass) this.pass = null;
    }
  }

  private tick(): void {
    if (this.pass || this.stopped) return;
    void this.runPass().catch((err: unknown) => {
      console.error("[schedules] pass failed:", err);
    });
  }

  private async passOnce(now?: Date): Promise<void> {
    if (!this.recovered) {
      this.recovered = true;
      await this.recover();
    }
    for (const schedule of this.deps.store.list()) {
      if (this.stopped) return;
      if (!schedule.enabled) continue;
      try {
        const run = await this.enqueue(schedule.id, () => this.claimDueRun(schedule.id, now ?? new Date()));
        // One start at a time: ten schedules due at 09:00 also spread their container starts.
        if (run) await this.startRun(run);
      } catch (err) {
        console.error(`[schedules] pass for schedule ${schedule.id} failed:`, err);
      }
    }
  }

  /** Steps 1–4 of a pass: collect, record the missed slots, claim the latest, and skip it if a run is going. */
  private claimDueRun(scheduleId: string, now: Date): ScheduleRun | null {
    const { store } = this.deps;
    const schedule = store.get(scheduleId);
    if (!schedule?.enabled) return null;
    let due: DueSlots | null;
    try {
      due = dueSlots(schedule, store.latestSlotAt(scheduleId), now);
    } catch (err) {
      this.setNeedsUser(schedule, `The schedule's timing can no longer be read: ${getErrorMessage(err)}`);
      return null;
    }
    if (!due) return null;
    const claimed = store.claimSlot({
      scheduleId,
      slotAt: due.latest,
      spec: schedule.spec,
      ...(due.missed ? { missed: { slotAt: due.missed.last, reason: missedReason(due.missed, schedule.timeZone) } } : {}),
    });
    if (!claimed) return null;
    if (due.missed) {
      const [, missed] = store.listRuns(scheduleId, 2);
      if (missed) this.announceRun(missed);
    }
    const going = this.goingRun(scheduleId, claimed.id);
    if (going) {
      const skipped = store.updateRun(claimed.id, { outcome: "skipped", reason: going });
      if (skipped) this.announceRun(skipped);
      return null;
    }
    this.announceRun(claimed);
    return claimed;
  }

  /**
   * Req 14 — why another run of the schedule still counts as going, or null. A run that
   * waits for the user's answer never does, background work or not (req 23).
   */
  private goingRun(scheduleId: string, exceptRunId: string): string | null {
    const { store, sessionManager, runnerRegistry, unprobedSessions } = this.deps;
    if (store.hasStartingRun(scheduleId, exceptRunId)) return "The previous run was still starting.";
    for (const sessionId of new Set([...runnerRegistry.ids(), ...(unprobedSessions ?? [])])) {
      const session = sessionManager.get(sessionId);
      if (session?.scheduleId !== scheduleId || session.scheduleRunId === exceptRunId) continue;
      if (sessionManager.isAwaitingAnswer(sessionId)) continue;
      const runner = runnerRegistry.get(sessionId);
      // No runner after a restart: a worker no probe reached may still be working.
      const busy = runner ? runner.agentBusy : unprobedSessions?.has(sessionId) === true;
      if (busy) return `The previous run, "${session.title}", was still going.`;
    }
    return null;
  }

  /** Req 26 — no checks: the run is claimed at once and starts behind the queue. */
  async runNow(scheduleId: string): Promise<ScheduleRun> {
    const run = await this.enqueue(scheduleId, () => {
      const schedule = this.deps.store.get(scheduleId);
      if (!schedule) throw new ServiceError(404, "Schedule not found");
      const inserted = this.deps.store.insertRun({ scheduleId, slotAt: null, spec: schedule.spec });
      if (!inserted) throw new ServiceError(500, "The run could not be recorded.");
      this.announceRun(inserted);
      return inserted;
    });
    void this.startRun(run).catch((err: unknown) => {
      console.error(`[schedules] Run now of ${scheduleId} failed:`, err);
    });
    return run;
  }

  /** `startScheduledRun` in the plan: pre-flight, then the headless start with the run's own spec. */
  private async startRun(run: ScheduleRun): Promise<void> {
    const schedule = this.deps.store.get(run.scheduleId);
    if (!schedule) return;
    const parsed = parseSessionStartSpec(run.spec);
    if ("problem" in parsed) {
      this.failRun(run.id, `The schedule's session description no longer reads: ${parsed.problem}`, true);
      return;
    }
    const { spec } = parsed;
    const problem = scheduleSpecProblem(spec, this.deps, "run");
    if (problem) {
      this.failRun(run.id, problem, true);
      return;
    }
    try {
      await this.deps.startSession({
        target: spec.target,
        params: spec.params,
        prompt: spec.prompt,
        title: runTitle(schedule, run),
        deliveryId: run.id,
        fetchBase: true,
        scheduleRun: { scheduleId: run.scheduleId, runId: run.id },
        // A due run was claimed while the schedule ran; a Run now run may start a paused one.
        dispatchGate: this.gate(run, { cancelOnPause: run.slotAt !== null || schedule.enabled }),
      });
    } catch (err) {
      this.startFailed(run.id, err);
    }
  }

  private startFailed(runId: string, err: unknown): void {
    // Work after the dispatch failed; the run itself is on its way.
    if (this.deps.store.getRun(runId)?.outcome === "started") {
      console.error(`[schedules] run ${runId} started, but the start then failed:`, err);
      return;
    }
    this.failRun(runId, getErrorMessage(err), !(err instanceof StartCancelled));
  }

  /**
   * Re-checks the schedule and the row inside the queue, then dispatches. A pause, a delete
   * or a stop since the claim cancels the start; the session it made stays linked to the run.
   */
  private gate(run: ScheduleRun, opts: { cancelOnPause: boolean; resend?: boolean }) {
    return (sessionId: string, dispatch: () => TurnHandle): Promise<TurnHandle> =>
      this.enqueue(run.scheduleId, () => {
        const current = this.deps.store.getRun(run.id);
        const schedule = this.deps.store.get(run.scheduleId);
        if (!current || !schedule) throw new StartCancelled("The schedule was deleted before the run started.");
        if (current.outcome !== (opts.resend ? "started" : "starting")) {
          throw new StartCancelled("The run was stopped before it started.");
        }
        if (opts.cancelOnPause && !schedule.enabled) {
          throw new StartCancelled("The schedule was paused before the run started.");
        }
        const turn = dispatch();
        this.markStarted(run.id, sessionId, turn);
        return turn;
      });
  }

  private markStarted(runId: string, sessionId: string, turn: TurnHandle): void {
    const { store } = this.deps;
    const before = store.getRun(runId);
    const run = before?.outcome === "started"
      ? before
      : store.updateRun(runId, { outcome: "started", sessionId, startedAt: new Date().toISOString(), reason: null });
    if (!run) return;
    if (run !== before) this.announceRun(run);
    const schedule = store.get(run.scheduleId);
    if (schedule) this.setNeedsUser(schedule, null);
    void (async () => {
      this.onFirstTurnSettled(runId, await turn.settled);
    })();
  }

  /**
   * The first-turn watch, part 1: a dispatch that failed during setup reports it through the
   * settlement, never as a throw, and no executor ran to record it.
   */
  private onFirstTurnSettled(runId: string, outcome: TurnOutcome): void {
    if (outcome.status !== "errored" || !outcome.detail?.startsWith(DISPATCH_SETUP_FAILURE)) return;
    const detail = outcome.detail.slice(DISPATCH_SETUP_FAILURE.length).replace(/^:\s*/, "");
    this.failStartedRun(runId, detail || "The run's first turn could not start.");
  }

  /**
   * The first-turn watch, part 2: the executor's record of the session's first turn end. A
   * quota refusal often settles as `completed`, so the settlement cannot tell it.
   */
  noteTurnEnd(end: TurnEnd): void {
    if (!end.first) return;
    const reason = firstTurnFailure(end);
    if (!reason) return;
    const runId = this.deps.sessionManager.get(end.sessionId)?.scheduleRunId;
    if (runId) this.failStartedRun(runId, reason);
  }

  /** Restores part 1 of the watch for a first turn adopted after a restart. */
  rebindDelivery(deliveryId: string): ((outcome: TurnOutcome) => void) | undefined {
    const run = this.deps.store.getRun(deliveryId);
    if (run?.outcome !== "starting" && run?.outcome !== "started") return undefined;
    return (outcome) => this.onFirstTurnSettled(run.id, outcome);
  }

  private failStartedRun(runId: string, reason: string): void {
    if (this.deps.store.getRun(runId)?.outcome !== "started") return;
    this.failRun(runId, reason, true);
  }

  /** Req 18 — a failed start keeps its session linked and, unless the user caused it, needs them. */
  private failRun(runId: string, reason: string, needsUser: boolean): void {
    const { store, sessionManager } = this.deps;
    const sessionId = sessionManager.sessionIdForScheduleRun(runId);
    const run = store.updateRun(runId, { outcome: "failed", reason, ...(sessionId ? { sessionId } : {}) });
    if (!run) return;
    console.warn(`[schedules] run ${runId} of schedule ${run.scheduleId} did not start: ${reason}`);
    this.announceRun(run);
    const schedule = store.get(run.scheduleId);
    if (needsUser && schedule) this.setNeedsUser(schedule, reason);
  }

  private setNeedsUser(schedule: Schedule, reason: string | null): void {
    if ((schedule.needsUserReason ?? null) === reason) return;
    this.deps.store.setNeedsUserReason(schedule.id, reason);
    this.announceSchedules();
  }

  /**
   * Finishes what a restart cut off. A run whose prompt reached its session is started —
   * or, in local mode, where no turn survives a restart, failed. One dispatched but not
   * delivered is sent again; one whose session was still being prepared is failed, since
   * its parameters may be half applied.
   */
  private async recover(): Promise<void> {
    const { store, sessionManager, runtimeMode } = this.deps;
    const pending = [...store.startingRuns(), ...store.startedRunsBeforeFirstTurnEnd()];
    for (const run of pending) {
      if (this.stopped) return;
      try {
        const sessionId = sessionManager.sessionIdForScheduleRun(run.id);
        if (!sessionId) {
          if (run.outcome === "starting") await this.startRun(run);
          continue;
        }
        const session = sessionManager.get(sessionId);
        if (!session || session.archived || session.userArchived) continue;
        if (this.delivered(sessionId, run.id)) {
          if (runtimeMode === "local") this.failRun(run.id, RESTARTED_DURING_RUN, true);
          else if (run.outcome === "starting") this.markRecoveredStart(run.id, sessionId);
          continue;
        }
        if (run.outcome === "starting") {
          this.failRun(run.id, RESTARTED_WHILE_PREPARING, true);
          continue;
        }
        await this.resend(run, sessionId);
      } catch (err) {
        console.error(`[schedules] recovering run ${run.id} failed:`, err);
      }
    }
  }

  private delivered(sessionId: string, runId: string): boolean {
    if (this.deps.runnerRegistry.get(sessionId)?.hasDelivery(runId)) return true;
    return this.deps.chatHistoryManager.load(sessionId).some((message) => message.role === "user");
  }

  /** The turn is restart-turn-reattach's now, as for any session; a rebound one is watched. */
  private markRecoveredStart(runId: string, sessionId: string): void {
    const run = this.deps.store.updateRun(runId, {
      outcome: "started",
      sessionId,
      startedAt: new Date().toISOString(),
      reason: null,
    });
    if (run) this.announceRun(run);
  }

  private async resend(run: ScheduleRun, sessionId: string): Promise<void> {
    const parsed = parseSessionStartSpec(run.spec);
    if ("problem" in parsed) {
      this.failRun(run.id, `The schedule's session description no longer reads: ${parsed.problem}`, true);
      return;
    }
    try {
      await this.deps.redispatch(sessionId, {
        params: parsed.spec.params,
        prompt: parsed.spec.prompt,
        deliveryId: run.id,
        // It started before the restart: a later pause applies from the next run (req 19).
        dispatchGate: this.gate(run, { cancelOnPause: false, resend: true }),
      });
      console.log(`[schedules] sent run ${run.id}'s prompt again after a restart`);
    } catch (err) {
      if (err instanceof StartCancelled) return;
      this.failRun(run.id, getErrorMessage(err), true);
    }
  }

  /** The browser follows schedules and their runs through these (the UI slices read them). */
  announceSchedules(): void {
    const now = new Date();
    this.deps.sseBroadcast("schedules", {
      schedules: this.deps.store.list().map((schedule) => toScheduleView(schedule, now)),
    });
  }

  private announceRun(run: ScheduleRun): void {
    this.deps.sseBroadcast("schedule_run", { run });
  }
}
