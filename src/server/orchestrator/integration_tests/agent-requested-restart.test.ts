// docs/321-agent-requested-restart — the request, the restart after the turn, and the note
// coming back as a turn, over real runners, the real restart and the real wake. Only the
// container manager is a stub: it reports the new container as running.
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionRunner, SessionRunnerRegistry, type SystemTurnDeps } from "../session-runner.js";
import { SessionManager } from "../sessions.js";
import { SessionContainerManager } from "../session-container.js";
import { GitManager } from "../../shared/git.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { WsServerMessage } from "../../shared/types.js";
import type { TurnOutcome } from "../turn-settlement.js";
import {
  recordRestartRequest,
  deferRestartToTurnEnd,
  userRestartPending,
  runRequestedRestart,
  buildRestartFollowupPrompt,
} from "../services/agent-restart-request.js";
import {
  createTestCredentialStore,
  createTestDatabaseManager,
  FakeClaudeProcess,
  StubAuthManager,
} from "./test-helpers.js";
import { allocateDeadLoopbackPort } from "./container-test-helpers.js";

// Prevent naming from launching a real agent CLI.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue({ name: null }),
}));
import {
  makeDispatchTurnDeps,
  testDispatch,
  waitForTurn,
  type FakeAgent,
} from "./dispatch-test-helpers.js";

const SESSION = "s1";
const NOTE = "check that node -v prints the new version";

function stubContainerManager(): SessionContainerManager & { destroyed: number; onDestroy?: () => void } {
  const cm: { destroyed: number; onDestroy?: () => void } & Record<string, unknown> = {
    destroyed: 0,
    // A replacement container has a new id, as a real one does.
    get: () => ({ status: "running", id: `container-${cm.destroyed}` }),
    destroyAgentContainer: async () => { cm.destroyed += 1; cm.onDestroy?.(); },
    getLastCreateError: () => null,
    clearCreateError: () => {},
  };
  return cm as unknown as SessionContainerManager & { destroyed: number; onDestroy?: () => void };
}

describe("agent-requested restart over real runners (docs/321)", () => {
  let db: DatabaseManager;

  afterEach(() => db.close());

  function setup() {
    db = createTestDatabaseManager();
    const sessionManager = new SessionManager(db);
    sessionManager.track(SESSION, "t", "/tmp/s1");
    const containerManager = stubContainerManager();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const registry: SessionRunnerRegistry = new SessionRunnerRegistry({
      onRunnerCreated: (runner) => runner.setSystemTurnDeps(turnDeps),
    });
    const turnDeps: SystemTurnDeps = {
      ...deps,
      runRequestedRestart: (turn) =>
        runRequestedRestart(
          { sessionManager, runnerRegistry: registry, defaultAgentId: "claude", containerManager },
          turn,
        ),
    };
    const prompts = () =>
      (deps.buildRunParams as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[2]));
    return { sessionManager, containerManager, agents, registry, prompts };
  }

  const endTurn = (agent: FakeAgent) => {
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agent.emit("done", 0);
  };

  it("restarts after the turn ends, then gives the note back as a turn on the new runner", async () => {
    const { sessionManager, containerManager, agents, registry, prompts } = setup();
    const first = registry.getOrCreate(SESSION, "/tmp/s1", "claude");
    const outcomes: TurnOutcome[] = [];
    first.dispatch(testDispatch({ text: "pin node 22 in .nvmrc", onTurnComplete: (o) => outcomes.push(o) }));
    await waitForTurn(() => agents.length === 1, "first turn");

    // The agent's `shipit session restart` during its turn: nothing restarts yet (req 2).
    recordRestartRequest({ sessionManager, containerManager }, SESSION, NOTE);
    await waitForTurn(() => agents[0]!.run.mock.calls.length === 1, "first turn running");
    expect(first.disposed).toBe(false);
    expect(containerManager.destroyed).toBe(0);

    endTurn(agents[0]!);
    await waitForTurn(() => agents.length === 2, "the follow-up turn");

    const second = registry.get(SESSION);
    expect(first.disposed).toBe(true);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(containerManager.destroyed).toBe(1);
    expect(sessionManager.getPendingRestartNote(SESSION)).toBeUndefined();
    await waitForTurn(() => prompts().length === 2, "follow-up prompt");
    expect(prompts()[1]).toContain(buildRestartFollowupPrompt(NOTE));
    // The restart's dispose must not report the finished turn as interrupted, then again.
    expect(outcomes).toEqual([expect.objectContaining({ status: "completed" })]);

    endTurn(agents[1]!);
    await waitForTurn(() => !second!.running, "follow-up settled");
    // One restart per request: the follow-up turn's end does not restart again.
    expect(registry.get(SESSION)).toBe(second);
    expect(containerManager.destroyed).toBe(1);
    second!.dispose({ force: true });
  });

  it("keeps a message sent during the restart and runs it after the follow-up turn", async () => {
    const { sessionManager, containerManager, agents, registry, prompts } = setup();
    const first = registry.getOrCreate(SESSION, "/tmp/s1", "claude");
    first.dispatch(testDispatch({ text: "pin node 22 in .nvmrc" }));
    await waitForTurn(() => agents.length === 1, "first turn");
    recordRestartRequest({ sessionManager, containerManager }, SESSION, NOTE);
    await waitForTurn(() => agents[0]!.run.mock.calls.length === 1, "first turn running");

    first.on("message", (msg: WsServerMessage) => {
      if (msg.type === "container_restarting" && msg.phase === "restarting_agent") {
        first.dispatch(testDispatch({ text: "sent while restarting" }));
      }
    });
    endTurn(agents[0]!);
    await waitForTurn(() => agents.length === 2, "the follow-up turn");

    const second = registry.get(SESSION)!;
    expect(second.messageQueue.map((m) => m.text)).toEqual(["sent while restarting"]);
    await waitForTurn(() => prompts().length === 2, "follow-up prompt");
    expect(prompts()[1]).toContain(NOTE);

    endTurn(agents[1]!);
    await waitForTurn(() => agents.length === 3, "the kept message's turn");
    await waitForTurn(() => prompts().length === 3, "kept message prompt");
    expect(prompts()[2]).toContain("sent while restarting");

    endTurn(agents[2]!);
    await waitForTurn(() => !second.running, "kept message settled");
    second.dispose({ force: true });
  });

  it("keeps a message that reached the old runner while no runner was registered", async () => {
    const { sessionManager, containerManager, agents, registry, prompts } = setup();
    const first = registry.getOrCreate(SESSION, "/tmp/s1", "claude");
    first.dispatch(testDispatch({ text: "pin node 22 in .nvmrc" }));
    await waitForTurn(() => agents.length === 1, "first turn");
    recordRestartRequest({ sessionManager, containerManager }, SESSION, NOTE);
    await waitForTurn(() => agents[0]!.run.mock.calls.length === 1, "first turn running");

    containerManager.onDestroy = () => {
      // A chat send falls back to the socket's attached runner while the registry is empty.
      expect(registry.get(SESSION)).toBeUndefined();
      first.dispatch(testDispatch({ text: "sent in the gap" }));
    };
    endTurn(agents[0]!);
    await waitForTurn(() => agents.length === 2, "the follow-up turn");

    const second = registry.get(SESSION)!;
    expect(second.messageQueue.map((m) => m.text)).toEqual(["sent in the gap"]);
    endTurn(agents[1]!);
    await waitForTurn(() => prompts().length === 3, "the kept message's turn");
    expect(prompts()[2]).toContain("sent in the gap");
    endTurn(agents[2]!);
    await waitForTurn(() => !second.running, "kept message settled");
    second.dispose({ force: true });
  });

  it("a restart requested while a queued message is waiting runs after that message's turn", async () => {
    const { sessionManager, containerManager, agents, registry } = setup();
    const first = registry.getOrCreate(SESSION, "/tmp/s1", "claude");
    first.dispatch(testDispatch({ text: "pin node 22 in .nvmrc" }));
    await waitForTurn(() => agents.length === 1, "first turn");
    recordRestartRequest({ sessionManager, containerManager }, SESSION, NOTE);
    first.dispatch(testDispatch({ text: "queued during the turn" }));
    expect(first.queueLength).toBe(1);

    endTurn(agents[0]!);
    await waitForTurn(() => agents.length === 2, "the queued message's turn");
    // The queued message runs on the old runner first; the restart waits for its end.
    expect(registry.get(SESSION)).toBe(first);
    expect(containerManager.destroyed).toBe(0);
    expect(sessionManager.getPendingRestartNote(SESSION)).toBe(NOTE);

    endTurn(agents[1]!);
    await waitForTurn(() => agents.length === 3, "the follow-up turn");
    expect(first.disposed).toBe(true);
    expect(containerManager.destroyed).toBe(1);
    const second = registry.get(SESSION)!;
    endTurn(agents[2]!);
    await waitForTurn(() => !second.running, "follow-up settled");
    second.dispose({ force: true });
  });

  // docs/242-stale-session-container-indicator req 9 — the user's "Restart after turn".
  it("the user's scheduled restart runs after the turn, starts no follow-up turn, and keeps a message", async () => {
    const { sessionManager, containerManager, agents, registry, prompts } = setup();
    const first = registry.getOrCreate(SESSION, "/tmp/s1", "claude");
    first.dispatch(testDispatch({ text: "a long task" }));
    await waitForTurn(() => agents.length === 1, "first turn");
    await waitForTurn(() => agents[0]!.run.mock.calls.length === 1, "first turn running");

    expect(deferRestartToTurnEnd({ sessionManager, containerManager, runnerRegistry: registry }, SESSION)).toBe(true);
    expect(first.disposed).toBe(false);
    expect(containerManager.destroyed).toBe(0);

    first.on("message", (msg: WsServerMessage) => {
      if (msg.type === "container_restarting" && msg.phase === "restarting_agent") {
        first.dispatch(testDispatch({ text: "sent while restarting" }));
      }
    });
    endTurn(agents[0]!);
    await waitForTurn(() => agents.length === 2, "the kept message's turn");

    const second = registry.get(SESSION)!;
    expect(first.disposed).toBe(true);
    expect(second).not.toBe(first);
    expect(containerManager.destroyed).toBe(1);
    expect(userRestartPending({ sessionManager, containerManager }, SESSION)).toBe(false);
    await waitForTurn(() => prompts().length === 2, "kept message prompt");
    // The only turn on the new runner is the user's own message: there is no follow-up turn.
    expect(prompts()[1]).toContain("sent while restarting");

    endTurn(agents[1]!);
    await waitForTurn(() => !second.running, "kept message settled");
    expect(registry.get(SESSION)).toBe(second);
    expect(containerManager.destroyed).toBe(1);
    second.dispose({ force: true });
  });
});

function createFakeDocker() {
  return {
    ping: async () => "OK",
    createNetwork: async () => ({ id: "net-fake" }),
    getNetwork: () => ({ inspect: async () => { throw new Error("not found"); } }),
    createContainer: async () => { throw new Error("no containers in this test"); },
    getContainer: () => ({ stop: async () => {}, remove: async () => {} }),
    listContainers: async () => [],
    getEvents: async () => new EventEmitter(),
  };
}

describe("POST /api/sessions/:id/restart-after-turn (docs/321)", () => {
  let tmpDir: string;
  let app: FastifyInstance | null = null;
  let db: DatabaseManager;
  let sessionManager: SessionManager;
  let containerManager: SessionContainerManager | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function build(withContainers: boolean): Promise<string> {
    db = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-restart-route-"));
    sessionManager = new SessionManager(db);
    containerManager = withContainers
      ? new SessionContainerManager({
          docker: createFakeDocker() as never,
          imageName: "shipit-session-worker:test",
          networkName: "shipit-test",
          workerPort: await allocateDeadLoopbackPort(),
          skipHealthCheck: true,
          stackName: "shipit-test",
        })
      : null;
    app = await buildApp({
      workspaceDir: tmpDir,
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      serveStatic: false,
      ...(containerManager
        ? {
            // Runners stay local: the route only records the request.
            runnerFactory: (o) => new SessionRunner(o),
            sessionContainerManager: containerManager,
          }
        : {}),
    });
    const created = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "t" } });
    return (created.json() as { sessionId: string }).sessionId;
  }

  const post = (id: string, body: unknown) =>
    app!.inject({ method: "POST", url: `/api/sessions/${id}/restart-after-turn`, payload: body as object });

  it("records the note in the session record", async () => {
    const id = await build(true);
    const res = await post(id, { note: "  check node -v  " });
    expect(res.statusCode).toBe(200);
    expect(sessionManager.getPendingRestartNote(id)).toBe("check node -v");
  });

  it("refuses an empty note and an unknown session", async () => {
    const id = await build(true);
    expect((await post(id, { note: " " })).statusCode).toBe(400);
    expect((await post("no-such-session", { note: "x" })).statusCode).toBe(404);
    expect(sessionManager.getPendingRestartNote(id)).toBeUndefined();
  });

  it("refuses with 503 where sessions run without containers", async () => {
    const id = await build(false);
    const res = await post(id, { note: "x" });
    expect(res.statusCode).toBe(503);
    expect(sessionManager.getPendingRestartNote(id)).toBeUndefined();
  });

  it("the restart route records the user's request while a turn runs (docs/242 req 9)", async () => {
    const id = await build(true);
    vi.spyOn(containerManager!, "get").mockReturnValue({ id: "container-1", status: "running" } as never);
    const runner = app!.runnerRegistry.getOrCreate(id, tmpDir, "claude");
    const restart = () => app!.inject({
      method: "POST",
      url: `/api/sessions/${id}/agent/container/restart`,
      payload: { afterTurn: true },
    });

    runner.running = true;
    expect((await restart()).json()).toEqual({ ok: true, scheduled: true });
    expect(sessionManager.getPendingUserRestart(id)).toBe("container-1");

    // Post-turn work: `running` is already false, and a restart now would dispose the runner.
    runner.running = false;
    runner.beginPostTurnWork();
    expect((await restart()).json()).toEqual({ ok: true, scheduled: true });
    runner.endPostTurnWork();

    expect(app!.runnerRegistry.get(id)).toBe(runner);
    expect(runner.disposed).toBe(false);
  });
});
