import type { ScheduleStore } from "./schedule-store.js";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { RuntimeMode } from "./app-di.js";
import type { CreateHeadlessSessionOptions, RedispatchOptions } from "./services/headless-sessions.js";
import type { TurnEnd, TurnHandle, TurnOutcome } from "./turn-settlement.js";
import type { DueSlots } from "../shared/schedule-timing.js";
import type { Schedule, ScheduleRun, ScheduleRunView, SessionInfo, UnfinishedScheduleRun } from "../shared/types.js";
import { DISPATCH_SETUP_FAILURE } from "./session-runner.js";
import { toListRow } from "./sessions.js";
import { isRunFinished, runResult } from "./run-finished.js";
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
const STOPPED_BEFORE_START = "The run was stopped before it started.";

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
  /** Sessions whose worker had work but no turn at the restart, so no runner follows them. */
  liveWorkSessions?: ReadonlySet<string>;
  /** Whether a session with no runner still works in its worker; without it, such a session counts as working. */
  probeLiveWork?: (sessionId: string) => Promise<boolean>;
  /** Ends the session's turn, as the chat's stop control does (req 33). */
  interruptTurn?: (sessionId: string) => void;
  /** `advanced.sessionStatusCard`: a run's manual steps count only while the card is on. */
  statusCardEnabled?: () => boolean;
}

/** The start was called off by a change the user made: no reason to show as needing them. */
class StartCancelled extends Error {}

function missedReason(missed: NonNullable<DueSlots["missed"]>, timeZone: string): string {
  const first = formatInZone(missed.first, timeZone);
  if (missed.count === 1) return `1 run missed, at ${first} (${timeZone}).`;
  return `${missed.count} runs missed between ${first} and ${formatInZone(missed.last, timeZone)} (${timeZone}).`;
}

/** "*schedule name* · *date*"; a Run now run is named by when it was asked for. */
function runTitle(schedule: Schedule, run: ScheduleRun): string {
  const at = new Date(run.slotAt ?? run.createdAt);
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
  private async claimDueRun(scheduleId: string, now: Date): Promise<ScheduleRun | null> {
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
    const going = await this.goingRun(scheduleId, claimed.id);
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
  private async goingRun(scheduleId: string, exceptRunId: string): Promise<string | null> {
    const { store, sessionManager, runnerRegistry, unprobedSessions, liveWorkSessions } = this.deps;
    if (store.hasStartingRun(scheduleId, exceptRunId)) return "The previous run was still starting.";
    const candidates = new Set([...runnerRegistry.ids(), ...(unprobedSessions ?? []), ...(liveWorkSessions ?? [])]);
    for (const sessionId of candidates) {
      const session = sessionManager.get(sessionId);
      if (session?.scheduleId !== scheduleId || session.scheduleRunId === exceptRunId) continue;
      if (sessionManager.isAwaitingAnswer(sessionId)) continue;
      if (await this.sessionBusy(sessionId)) return `The previous run, "${session.title}", was still going.`;
    }
    return null;
  }

  /**
   * After a restart a session can work with no runner, and the restart's sets never empty,
   * so its worker is asked each time rather than the set trusted for good.
   */
  private async sessionBusy(sessionId: string): Promise<boolean> {
    const { runnerRegistry, unprobedSessions, liveWorkSessions, probeLiveWork } = this.deps;
    const runner = runnerRegistry.get(sessionId);
    if (runner) return runner.agentBusy;
    if (!unprobedSessions?.has(sessionId) && !liveWorkSessions?.has(sessionId)) return false;
    return probeLiveWork ? probeLiveWork(sessionId) : true;
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
        // A pause stops due runs; Run now has no restrictions (req 26).
        dispatchGate: this.gate(run, { cancelOnPause: run.slotAt !== null }),
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
        if (!current || !schedule) throw this.calledOff(sessionId, "The schedule was deleted before the run started.");
        if (current.outcome !== (opts.resend ? "started" : "starting")) throw this.calledOff(sessionId, STOPPED_BEFORE_START);
        // A stopped run takes no turn the user did not start (req 33); a re-sent prompt is one.
        if (opts.resend && this.deps.sessionManager.get(sessionId)?.runStoppedAt) {
          throw this.calledOff(sessionId, "The run was stopped.");
        }
        if (opts.cancelOnPause && !schedule.enabled) {
          throw new StartCancelled("The schedule was paused before the run started.");
        }
        const turn = dispatch();
        this.markStarted(run.id, sessionId, turn);
        return turn;
      });
  }

  /**
   * A start called off here follows a Stop or a Delete (which waits for runs still starting),
   * so the session carries the stop — also one made before the session existed (req 33).
   */
  private calledOff(sessionId: string, reason: string): StartCancelled {
    this.markRunStopped(sessionId);
    return new StartCancelled(reason);
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
    if (run) {
      console.warn(`[schedules] run ${runId} of schedule ${run.scheduleId} did not start: ${reason}`);
      this.announceRun(run);
      const schedule = store.get(run.scheduleId);
      if (needsUser && schedule) this.setNeedsUser(schedule, reason);
    }
    // A session that never got its prompt has no turn whose end would decide it.
    if (sessionId) this.decideRunFinished(sessionId);
  }

  /**
   * Decides again whether the run is finished, and saves it (`run_finished_at`); never while
   * its runner is busy. A run that becomes finished copies its one-line result into its row,
   * which outlives the session (req 24). Returns whether the decision changed. Never throws:
   * it runs at a turn's end and inside the PR poller.
   */
  decideRunFinished(sessionId: string): boolean {
    try {
      const { sessionManager, runnerRegistry } = this.deps;
      const session = sessionManager.get(sessionId);
      if (!session?.scheduleId || runnerRegistry.get(sessionId)?.agentBusy) return false;
      const statusCardOn = this.deps.statusCardEnabled?.() ?? false;
      const row = session.scheduleRunId ? this.deps.store.getRun(session.scheduleRunId) : null;
      const finished = isRunFinished({
        run: session,
        starting: row?.outcome === "starting",
        prOpen: sessionManager.getPrStatus(sessionId)?.prState === "open",
        statusCardOn,
      });
      if (finished === !!session.runFinishedAt) return false;
      sessionManager.setRunFinishedAt(sessionId, finished ? new Date().toISOString() : null);
      if (finished) this.keepResult(session, statusCardOn);
      this.deps.sseBroadcast("session_list", { sessions: sessionManager.list() });
      return true;
    } catch (err) {
      console.error(`[schedules] deciding whether run session ${sessionId} is finished failed:`, err);
      return false;
    }
  }

  private keepResult(session: SessionInfo, statusCardOn: boolean): void {
    if (!session.scheduleRunId) return;
    const result = runResult(session, statusCardOn, this.deps.chatHistoryManager.load(session.id));
    if (!result) return;
    // A deleted schedule took its run rows with it; the update then finds none.
    const run = this.deps.store.updateRun(session.scheduleRunId, { result });
    if (run) this.announceRun(run);
  }

  /**
   * Req 33 — the run counts as finished, and holds every automatic turn, until the user's
   * next turn in it. The caller interrupts a turn that is going.
   */
  markRunStopped(sessionId: string): void {
    const { sessionManager } = this.deps;
    if (!sessionManager.get(sessionId)?.scheduleId) return;
    sessionManager.setRunStoppedAt(sessionId, new Date().toISOString());
    // While the turn winds down nothing is decided, but the list shows the stop at once.
    if (!this.decideRunFinished(sessionId)) {
      this.deps.sseBroadcast("session_list", { sessions: sessionManager.list() });
    }
  }

  /**
   * Req 33 — Stop on a run's row, in the Delete refusal and in its banner. A run still
   * starting is cancelled: the gate re-reads its row before the dispatch. A run whose
   * schedule was deleted is found through its session. Null when no row is left.
   */
  stopRun(scheduleId: string, runId: string): Promise<ScheduleRun | null> {
    return this.enqueue(scheduleId, () => {
      const { store, sessionManager } = this.deps;
      const run = store.getRun(runId);
      const sessionId = sessionManager.sessionIdForScheduleRun(runId);
      const owner = run?.scheduleId ?? (sessionId ? sessionManager.get(sessionId)?.scheduleId : undefined);
      if (owner !== scheduleId) throw new ServiceError(404, "Run not found");
      if (run?.outcome === "starting") {
        const cancelled = store.updateRun(runId, {
          outcome: "failed",
          reason: STOPPED_BEFORE_START,
          ...(sessionId ? { sessionId } : {}),
        });
        if (cancelled) this.announceRun(cancelled);
      }
      if (sessionId) {
        this.markRunStopped(sessionId);
        this.deps.interruptTurn?.(sessionId);
      }
      return store.getRun(runId);
    });
  }

  /**
   * Reqs 26 and 32 — the runs that are not finished, archived ones included: those still
   * starting, those whose decision is not "finished", and any whose agent still works, such
   * as a stopped one winding down. Each idle run is decided again first, so a decision a
   * missed moment left stale neither blocks Delete nor lets it through.
   */
  async unfinishedRuns(scheduleId: string): Promise<UnfinishedScheduleRun[]> {
    const { store, sessionManager } = this.deps;
    const unfinished: UnfinishedScheduleRun[] = [];
    const listed = new Set<string>();
    for (const candidate of sessionManager.runSessionsOfSchedule(scheduleId)) {
      if (!candidate.scheduleRunId) continue;
      const busy = await this.sessionBusy(candidate.id);
      if (!busy) this.decideRunFinished(candidate.id);
      const session = sessionManager.get(candidate.id) ?? candidate;
      if (session.runFinishedAt && !busy) continue;
      listed.add(candidate.scheduleRunId);
      unfinished.push({
        runId: candidate.scheduleRunId,
        sessionId: session.id,
        title: session.title,
        ...(session.archived || session.userArchived ? { archived: true } : {}),
        ...(session.runStoppedAt ? { stopping: true } : {}),
      });
    }
    const schedule = store.get(scheduleId);
    for (const run of store.startingRuns()) {
      if (run.scheduleId !== scheduleId || listed.has(run.id) || !schedule) continue;
      unfinished.push({ runId: run.id, title: runTitle(schedule, run) });
    }
    return unfinished;
  }

  /**
   * Req 24 — each run with its session as the lists show it, archived ones included. The
   * result a run kept is its last finish's, so one not finished — never, or not since the user
   * reopened it — reads its current one from its session.
   */
  viewRuns(runs: ScheduleRun[]): ScheduleRunView[] {
    const { sessionManager, chatHistoryManager } = this.deps;
    const statusCardOn = this.deps.statusCardEnabled?.() ?? false;
    return runs.map((run) => {
      const sessionId = run.sessionId ?? sessionManager.sessionIdForScheduleRun(run.id);
      if (!sessionId) return run;
      const session = sessionManager.get(sessionId);
      if (!session) return { ...run, sessionId, sessionDeleted: true };
      const result = session.runFinishedAt
        ? run.result
        : runResult(session, statusCardOn, chatHistoryManager.load(sessionId)) ?? run.result;
      return { ...run, sessionId, session: toListRow(session), ...(result ? { result } : {}) };
    });
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
        // A worker no probe reached may still be running the turn; the overlap rule waits for it.
        if (this.deps.unprobedSessions?.has(sessionId)) continue;
        await this.resend(run, sessionId);
      } catch (err) {
        console.error(`[schedules] recovering run ${run.id} failed:`, err);
      }
    }
  }

  /** The prompt's row is saved before the agent gets it, so only the agent's answer proves it arrived. */
  private delivered(sessionId: string, runId: string): boolean {
    if (this.deps.runnerRegistry.get(sessionId)?.hasDelivery(runId)) return true;
    const messages = this.deps.chatHistoryManager.load(sessionId);
    const prompt = messages.findIndex((message) => message.role === "user");
    return prompt >= 0 && messages.slice(prompt + 1).some((message) => message.role === "assistant" && !message.notice);
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
