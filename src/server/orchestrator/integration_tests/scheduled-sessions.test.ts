import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Session naming must not start a provider CLI.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue({ name: null }),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import type { AppDeps } from "../app-di.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { ScheduleStore } from "../schedule-store.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { CredentialStore } from "../credential-store.js";
import { DatabaseManager } from "../../shared/database.js";
import type { ScheduleRun, ScheduleView, UnfinishedScheduleRun } from "../../shared/types.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { testDispatch } from "./dispatch-test-helpers.js";
import {
  FakeClaudeProcess,
  StubAuthManager,
  StubGitHubAuthManager,
  createTestCredentialStore,
} from "./test-helpers.js";

/** docs/324-scheduled-sessions — the scheduler end to end, on real headless starts of sandbox runs. */

const PROMPT = "Check current security PRs and merge them.";
const SPEC = { target: { kind: "sandbox", capabilities: { network: true } }, params: {}, prompt: PROMPT };
const DAILY_0900_UTC = { kind: "daily", hour: 9, minute: 0 };
const QUOTA_ERROR = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";
const at = (iso: string) => new Date(iso);

let app: FastifyInstance;
let tmpDir: string;
let dbManager: DatabaseManager;
let sessionManager: SessionManager;
let repoStore: RepoStore;
let credentialStore: CredentialStore;
let schedules: ScheduleStore;
let agents: FakeClaudeProcess[];

/** File-backed: an app closes its database on shutdown, and a restart opens it again. */
function openStores(): void {
  dbManager = new DatabaseManager(path.join(tmpDir, "shipit.db"));
  sessionManager = new SessionManager(dbManager);
  repoStore = new RepoStore(dbManager);
  schedules = new ScheduleStore(dbManager);
}

function appDeps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    databaseManager: dbManager,
    credentialStore,
    createGitManager: (dir: string) => new GitManager(dir),
    sessionManager,
    repoStore,
    authManager: new StubAuthManager() as unknown as AuthManager,
    githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
    agentFactory: () => {
      const agent = new FakeClaudeProcess();
      agents.push(agent);
      return agent as never;
    },
    workspaceDir: tmpDir,
    serveStatic: false,
    ...over,
  };
}

/** A restart: a new orchestrator on the same database, whose startup pass recovers what it finds. */
async function restart(over: Partial<AppDeps> = {}): Promise<void> {
  await app.close();
  openStores();
  app = await buildApp(appDeps(over));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor("${label}") timed out`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Created through the route, then made active since 08:00 UTC on 2026-10-07 (or the given time). */
async function createSchedule(activeSince = "2026-10-07T08:00:00.000Z", spec: object = SPEC): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/schedules",
    payload: { name: "Nightly", timing: DAILY_0900_UTC, timeZone: "UTC", spec },
  });
  expect(res.statusCode, res.body).toBe(201);
  const { schedule } = res.json() as { schedule: ScheduleView };
  schedules.update(schedule.id, { activeSince });
  return schedule.id;
}

async function runsOf(scheduleId: string): Promise<ScheduleRun[]> {
  const res = await app.inject({ method: "GET", url: `/api/schedules/${scheduleId}/runs` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { runs: ScheduleRun[] }).runs;
}

function runSessions(scheduleId: string) {
  return sessionManager.list().filter((s) => s.scheduleId === scheduleId);
}

/** A run whose turn the fake agent is still working on. */
async function startRunningRun(scheduleId: string, now: string): Promise<string> {
  const before = agents.length;
  await app.scheduleRunner.runPass(at(now));
  await waitFor(() => agents.length > before && agents.at(-1)!.runCalled, "the run's agent");
  const [run] = await runsOf(scheduleId);
  expect(run).toMatchObject({ outcome: "started" });
  return run!.sessionId!;
}

/** A sandbox session with a workspace, linked to a run row as the start would leave it. */
async function linkedSandbox(scheduleId: string, runId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/sessions/sandbox", payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  const sessionId = (res.json() as { session: { id: string } }).session.id;
  sessionManager.setScheduleRun(sessionId, scheduleId, runId);
  return sessionId;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-schedules-"));
  openStores();
  credentialStore = createTestCredentialStore(tmpDir);
  agents = [];
  app = await buildApp(appDeps());
});

afterEach(async () => {
  await app.close();
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("Integration: scheduled runs", () => {
  it("starts a due run as a session of its own, with the schedule's prompt (reqs 1, 2, 7)", { timeout: 15_000 }, async () => {
    const id = await createSchedule();
    await app.scheduleRunner.runPass(at("2026-10-07T08:59:00Z"));
    expect(runSessions(id)).toHaveLength(0);

    const sessionId = await startRunningRun(id, "2026-10-07T09:00:30Z");
    const session = sessionManager.get(sessionId)!;
    const [run] = await runsOf(id);
    expect(session).toMatchObject({ kind: "sandbox", scheduleId: id, scheduleRunId: run!.id, title: "Nightly · Oct 7, 09:00" });
    expect(agents[0]!.lastPrompt).toContain(PROMPT);

    agents[0]!.finish();
    await waitFor(() => sessionManager.get(sessionId)?.lastTurnOutcome === "ok", "the turn's outcome");
  });

  it("starts a slot once when two passes run together", { timeout: 15_000 }, async () => {
    const id = await createSchedule();
    const now = at("2026-10-07T09:00:30Z");
    await Promise.all([app.scheduleRunner.runPass(now), app.scheduleRunner.runPass(now)]);
    await waitFor(() => agents.length >= 1, "the run's agent");
    expect(runSessions(id)).toHaveLength(1);
    expect(await runsOf(id)).toHaveLength(1);
  });

  it("after downtime runs once, and records the missed runs as one skipped row (req 15)", { timeout: 15_000 }, async () => {
    const id = await createSchedule("2026-10-04T08:00:00.000Z");
    await startRunningRun(id, "2026-10-07T09:00:30Z");
    expect(runSessions(id)).toHaveLength(1);
    expect((await runsOf(id)).map((r) => [r.outcome, r.reason])).toEqual([
      ["started", undefined],
      ["skipped", "3 runs missed between 2026-10-04 09:00 and 2026-10-06 09:00 (UTC)."],
    ]);
  });

  it("skips a run while the previous one is still going, but not while it waits for an answer (reqs 14, 23)", { timeout: 15_000 }, async () => {
    const id = await createSchedule();
    const first = await startRunningRun(id, "2026-10-07T09:00:30Z");

    await app.scheduleRunner.runPass(at("2026-10-08T09:00:30Z"));
    expect(runSessions(id)).toHaveLength(1);
    expect((await runsOf(id))[0]).toMatchObject({
      outcome: "skipped",
      reason: 'The previous run, "Nightly · Oct 7, 09:00", was still going.',
    });

    // The turn ends on a question while its post-turn work still runs.
    agents[0]!.finish();
    await waitFor(() => sessionManager.get(first)?.lastTurnOutcome === "ok", "the first turn's end");
    await app.inject({ method: "POST", url: `/api/_test/runner/${first}/running`, payload: { postTurnWork: true } });
    sessionManager.setAwaitingAnswer(first, true);

    await startRunningRun(id, "2026-10-09T09:00:30Z");
    expect(runSessions(id)).toHaveLength(2);
  });

  it("Run now starts a run past a going one, on a paused schedule (req 26)", { timeout: 15_000 }, async () => {
    const id = await createSchedule();
    await startRunningRun(id, "2026-10-07T09:00:30Z");
    const pause = await app.inject({ method: "POST", url: `/api/schedules/${id}/pause` });
    expect((pause.json() as { schedule: ScheduleView }).schedule.enabled).toBe(false);

    const res = await app.inject({ method: "POST", url: `/api/schedules/${id}/run` });
    expect(res.statusCode, res.body).toBe(202);
    expect((res.json() as { run: ScheduleRun }).run).toMatchObject({ slotAt: null, outcome: "starting" });
    await waitFor(() => agents.length === 2 && agents[1]!.runCalled, "the Run now run's agent");
    expect(runSessions(id)).toHaveLength(2);
  });

  it("fails the start when the first turn is refused for quota, and marks the schedule (req 18)", { timeout: 15_000 }, async () => {
    // An API key never fails over to another credential, so its refusal ends the turn.
    const keyed = {
      ...SPEC,
      params: { agent: "claude", serviceId: "anthropic", billingMode: "key", model: "claude-sonnet-5" },
    };
    const id = await createSchedule(undefined, keyed);
    await startRunningRun(id, "2026-10-07T09:00:30Z");
    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitFor(() => schedules.listRuns(id)[0]?.outcome === "failed", "the failed start");

    const [run] = await runsOf(id);
    expect(agents).toHaveLength(1);
    expect(run).toMatchObject({
      outcome: "failed",
      sessionId: expect.any(String),
      reason: `The agent's account is out of quota: ${QUOTA_ERROR}`,
    });
    const res = await app.inject({ method: "GET", url: `/api/schedules/${id}` });
    expect((res.json() as { schedule: ScheduleView }).schedule.needsUserReason).toBe(run!.reason);
  });
});

describe("Integration: recovery after a restart", () => {
  it("starts a run that was claimed but had no session yet", { timeout: 15_000 }, async () => {
    const id = await createSchedule("2026-10-07T09:00:00.000Z");
    const run = schedules.insertRun({ scheduleId: id, slotAt: at("2026-10-07T09:00:00Z"), spec: SPEC })!;
    await restart();
    await app.scheduleRunner.runPass(at("2026-10-07T09:01:00Z"));
    await waitFor(() => agents.length === 1 && agents[0]!.runCalled, "the recovered run's agent");
    expect(schedules.getRun(run.id)).toMatchObject({ outcome: "started" });
    expect(sessionManager.get(schedules.getRun(run.id)!.sessionId!)?.scheduleRunId).toBe(run.id);
  });

  it("does not start again a run whose prompt the agent answered", { timeout: 15_000 }, async () => {
    const id = await createSchedule("2026-10-07T09:00:00.000Z");
    const run = schedules.insertRun({ scheduleId: id, slotAt: at("2026-10-07T09:00:00Z"), spec: SPEC })!;
    const sessionId = await linkedSandbox(id, run.id);
    app.chatHistoryManager.append(sessionId, { role: "user", text: PROMPT });
    app.chatHistoryManager.append(sessionId, { role: "assistant", text: "Looking at the open PRs." });
    await restart();
    await app.scheduleRunner.runPass(at("2026-10-07T09:01:00Z"));
    expect(schedules.getRun(run.id)).toMatchObject({ outcome: "started", sessionId });
    expect(agents).toHaveLength(0);
    expect(runSessions(id)).toHaveLength(1);
  });

  it("fails a run whose session was still being prepared, and keeps the session linked", { timeout: 15_000 }, async () => {
    const id = await createSchedule("2026-10-07T09:00:00.000Z");
    const run = schedules.insertRun({ scheduleId: id, slotAt: at("2026-10-07T09:00:00Z"), spec: SPEC })!;
    const sessionId = await linkedSandbox(id, run.id);
    await restart();
    await app.scheduleRunner.runPass(at("2026-10-07T09:01:00Z"));
    expect(schedules.getRun(run.id)).toMatchObject({
      outcome: "failed",
      sessionId,
      reason: "ShipIt restarted while this run's session was being prepared.",
    });
    expect(agents).toHaveLength(0);
  });

  it("sends the prompt again to a started run whose dispatch never arrived", { timeout: 15_000 }, async () => {
    const id = await createSchedule("2026-10-07T09:00:00.000Z");
    const run = schedules.insertRun({
      scheduleId: id, slotAt: at("2026-10-07T09:00:00Z"), spec: SPEC, outcome: "started",
    })!;
    const sessionId = await linkedSandbox(id, run.id);
    await restart();
    await app.scheduleRunner.runPass(at("2026-10-07T09:01:00Z"));
    await waitFor(() => agents.length === 1 && agents[0]!.runCalled, "the re-sent prompt");
    expect(agents[0]!.lastPrompt).toContain(PROMPT);
    expect(schedules.getRun(run.id)).toMatchObject({ outcome: "started" });
    expect(runSessions(id).map((s) => s.id)).toEqual([sessionId]);
  });

  it("in local mode, fails a run whose turn the restart cut off", { timeout: 15_000 }, async () => {
    const id = await createSchedule("2026-10-07T09:00:00.000Z");
    const run = schedules.insertRun({
      scheduleId: id, slotAt: at("2026-10-07T09:00:00Z"), spec: SPEC, outcome: "started",
    })!;
    const sessionId = await linkedSandbox(id, run.id);
    app.chatHistoryManager.append(sessionId, { role: "user", text: PROMPT });
    app.chatHistoryManager.append(sessionId, { role: "assistant", text: "Looking at the open PRs." });
    await restart({ runtimeMode: "local" });
    await app.scheduleRunner.runPass(at("2026-10-07T09:01:00Z"));
    expect(schedules.getRun(run.id)).toMatchObject({ outcome: "failed", reason: "ShipIt restarted during the run." });
    expect(schedules.get(id)?.needsUserReason).toBe("ShipIt restarted during the run.");
    expect(agents).toHaveLength(0);
  });
});

describe("Integration: schedule routes", () => {
  it("creates, reads, edits, pauses and resumes a schedule, and refuses what cannot be saved", { timeout: 15_000 }, async () => {
    const id = await createSchedule();
    const list = await app.inject({ method: "GET", url: "/api/schedules" });
    expect((list.json() as { schedules: ScheduleView[] }).schedules.map((s) => s.id)).toEqual([id]);

    const edited = await app.inject({
      method: "PUT",
      url: `/api/schedules/${id}`,
      payload: { timing: { kind: "weekdays", hour: 7, minute: 30 } },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const { schedule } = edited.json() as { schedule: ScheduleView };
    expect(schedule.timing).toEqual({ kind: "weekdays", hour: 7, minute: 30 });
    expect(Date.parse(schedule.activeSince)).toBeGreaterThan(Date.parse("2026-10-07T08:00:00.000Z"));

    const tooClose = await app.inject({
      method: "PUT",
      url: `/api/schedules/${id}`,
      payload: { timing: { kind: "cron", expression: "0,30 9 * * *" } },
    });
    expect(tooClose.statusCode).toBe(400);
    expect(tooClose.json()).toEqual({ error: expect.stringContaining("at least an hour apart") });

    const paused = await app.inject({ method: "POST", url: `/api/schedules/${id}/pause` });
    expect((paused.json() as { schedule: ScheduleView }).schedule).toMatchObject({ enabled: false, nextRuns: [] });
    const resumed = await app.inject({ method: "POST", url: `/api/schedules/${id}/resume` });
    expect((resumed.json() as { schedule: ScheduleView }).schedule.nextRuns).toHaveLength(3);

    expect((await app.inject({ method: "GET", url: "/api/schedules/missing" })).statusCode).toBe(404);
    const bad = await app.inject({ method: "POST", url: "/api/schedules", payload: { name: "x" } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("Integration: finished runs, Stop and Delete (reqs 22, 31, 32, 33)", () => {
  const registry = () => (app as unknown as { runnerRegistry: SessionRunnerRegistry }).runnerRegistry;
  const idle = (sessionId: string) => !(registry().get(sessionId)?.agentBusy ?? false);
  const finishedAt = (sessionId: string) => sessionManager.get(sessionId)?.runFinishedAt;

  async function stop(scheduleId: string, runId: string): Promise<void> {
    const res = await app.inject({ method: "POST", url: `/api/schedules/${scheduleId}/runs/${runId}/stop` });
    expect(res.statusCode, res.body).toBe(200);
  }

  it("files a run whose turn left nothing for the user as finished, and keeps its result (req 22)", { timeout: 15_000 }, async () => {
    const id = await createSchedule();
    const sessionId = await startRunningRun(id, "2026-10-07T09:00:30Z");
    agents[0]!.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Merged two security PRs.\nBoth had green checks." }] },
    });
    agents[0]!.finish();
    await waitFor(() => !!finishedAt(sessionId), "the run filed as finished");
    expect((await runsOf(id))[0]).toMatchObject({ outcome: "started", result: "Merged two security PRs." });
  });

  it("does not file a run whose turn ended on an error (req 31)", { timeout: 15_000 }, async () => {
    const id = await createSchedule();
    const sessionId = await startRunningRun(id, "2026-10-07T09:00:30Z");
    agents[0]!.emit("event", { type: "agent_result", error: "The model returned an error.", sessionId: "agent-sid" });
    agents[0]!.emit("done", 1);
    await waitFor(() => sessionManager.get(sessionId)?.lastTurnOutcome === "errored" && idle(sessionId), "the turn's end");
    expect(finishedAt(sessionId)).toBeUndefined();
  });

  it("keeps a run with an open PR unfinished, and decides again when the poller sees the PR change (req 22)", { timeout: 15_000 }, async () => {
    const id = await createSchedule();
    const sessionId = await startRunningRun(id, "2026-10-07T09:00:30Z");
    sessionManager.setPrStatus(sessionId, { sessionId, prNumber: 7, prState: "open" } as never);
    agents[0]!.finish();
    await waitFor(() => sessionManager.get(sessionId)?.lastTurnOutcome === "ok" && idle(sessionId), "the turn's end");
    expect(finishedAt(sessionId)).toBeUndefined();

    app.prStatusPoller!.clearPersisted(sessionId);
    expect(finishedAt(sessionId)).toBeDefined();
  });

  it("a stopped run takes no automatic turn until the user's next turn in it (req 33)", { timeout: 15_000 }, async () => {
    const id = await createSchedule();
    const sessionId = await startRunningRun(id, "2026-10-07T09:00:30Z");
    const [run] = await runsOf(id);
    await stop(id, run!.id);
    expect(agents[0]!.interrupted || agents[0]!.killed).toBe(true);
    await waitFor(() => !!finishedAt(sessionId) && idle(sessionId), "the stopped run filed as finished");

    const runner = registry().get(sessionId)!;
    const fix = runner.dispatch(testDispatch({ text: "CI failed on main: fix it.", automatic: true }));
    expect(fix.admitted).toBe("queued");
    expect(sessionManager.heldTurns(sessionId).map((m) => m.text)).toEqual(["CI failed on main: fix it."]);
    expect(agents).toHaveLength(1);

    // The user's own turn makes the run active again; what was held runs after it.
    runner.dispatch(testDispatch({ text: "Only list the PRs this time." }));
    await waitFor(() => agents.length === 2 && agents[1]!.runCalled, "the user's turn");
    expect(sessionManager.get(sessionId)).not.toHaveProperty("runStoppedAt");
    expect(sessionManager.get(sessionId)).not.toHaveProperty("runFinishedAt");
    agents[1]!.finish();
    await waitFor(() => agents.length === 3 && agents[2]!.runCalled, "the held automatic turn");
    expect(agents[2]!.lastPrompt).toContain("CI failed on main: fix it.");
    agents[2]!.finish();
    await waitFor(() => !!finishedAt(sessionId), "the run filed as finished again");
  });

  it("Stop on a run still starting cancels its dispatch (req 33)", { timeout: 15_000 }, async () => {
    const id = await createSchedule();
    // Stops the run the moment its session is linked, which is before its dispatch.
    let stopping: Promise<unknown> | undefined;
    const link = sessionManager.setScheduleRun.bind(sessionManager);
    vi.spyOn(sessionManager, "setScheduleRun").mockImplementation((sessionId, scheduleId, runId) => {
      link(sessionId, scheduleId, runId);
      stopping = app.scheduleRunner.stopRun(scheduleId, runId);
    });
    await app.scheduleRunner.runPass(at("2026-10-07T09:00:30Z"));
    await stopping;

    const [run] = await runsOf(id);
    expect(run).toMatchObject({ outcome: "failed", reason: "The run was stopped before it started.", sessionId: expect.any(String) });
    expect(agents).toHaveLength(0);
    expect(finishedAt(run!.sessionId!)).toBeDefined();
    expect(schedules.get(id)?.needsUserReason).toBeUndefined();
  });

  it("refuses Delete while a run is going and names it, and deletes once the run is stopped (req 32)", { timeout: 15_000 }, async () => {
    const id = await createSchedule();
    const sessionId = await startRunningRun(id, "2026-10-07T09:00:30Z");
    const [run] = await runsOf(id);
    const going: UnfinishedScheduleRun[] = [{ runId: run!.id, sessionId, title: "Nightly · Oct 7, 09:00" }];

    const refused = await app.inject({ method: "DELETE", url: `/api/schedules/${id}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: expect.stringContaining("still has runs in progress"), runs: going });
    // Run now's warning reads the same runs (req 26).
    const warning = await app.inject({ method: "GET", url: `/api/schedules/${id}/unfinished-runs` });
    expect(warning.json()).toEqual({ runs: going });

    await stop(id, run!.id);
    await waitFor(() => !!finishedAt(sessionId) && idle(sessionId), "the stopped run filed as finished");
    const deleted = await app.inject({ method: "DELETE", url: `/api/schedules/${id}` });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/schedules/${id}` })).statusCode).toBe(404);
    expect(schedules.listRuns(id)).toEqual([]);
    // The run's session stays, still naming its schedule, so it can say it was deleted.
    expect(sessionManager.get(sessionId)).toMatchObject({ scheduleId: id, scheduleRunId: run!.id });
  });
});
