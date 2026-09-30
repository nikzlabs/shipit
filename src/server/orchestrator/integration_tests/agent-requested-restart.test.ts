// docs/321-agent-requested-restart — the request, the restart after the turn, and the note
// coming back as a turn, over real runners, the real restart and the real wake. Only the
// container manager is a stub: it reports the new container as running.
import { describe, it, expect, afterEach } from "vitest";
import { SessionRunnerRegistry, type SystemTurnDeps } from "../session-runner.js";
import { SessionManager } from "../sessions.js";
import type { SessionContainerManager } from "../session-container.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { WsServerMessage } from "../../shared/types.js";
import {
  recordRestartRequest,
  runRequestedRestart,
  buildRestartFollowupPrompt,
} from "../services/agent-restart-request.js";
import { createTestDatabaseManager } from "./test-helpers.js";
import {
  makeDispatchTurnDeps,
  testDispatch,
  waitForTurn,
  type FakeAgent,
} from "./dispatch-test-helpers.js";

const SESSION = "s1";
const NOTE = "check that node -v prints the new version";

function stubContainerManager(): SessionContainerManager & { destroyed: number } {
  const cm = {
    destroyed: 0,
    get: () => ({ status: "running" }),
    destroyAgentContainer: async () => { cm.destroyed += 1; },
    getLastCreateError: () => null,
    clearCreateError: () => {},
  };
  return cm as unknown as SessionContainerManager & { destroyed: number };
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
    first.dispatch(testDispatch({ text: "pin node 22 in .nvmrc" }));
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
});
