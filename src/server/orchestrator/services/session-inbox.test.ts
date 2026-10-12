import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import type { AgentId } from "../../shared/types.js";
import { SessionManager } from "../sessions.js";
import { SessionInboxStore } from "../session-inbox-store.js";
import { SessionRunnerRegistry, type SessionRunnerInterface, type SystemTurnDeps } from "../session-runner.js";
import {
  flushTurn,
  makeDispatchTurnDeps,
  testDispatch,
  waitForTurn,
  type FakeAgent,
} from "../integration_tests/dispatch-test-helpers.js";
import { requeueUndeliveredSteers } from "../ws-handlers/agent-message-builder.js";
import { buildInboxNotice, INBOX_TURN_TEXT, prepareInboxNotice } from "./session-inbox-notice.js";
import { SessionInbox } from "./session-inbox.js";
import { noteTurnReady } from "../turn-stop-request.js";

const CHILD = { sessionId: "child", sessionTitle: "Child", relation: "child" as const };
const APPROVED = { sessionId: "other", sessionTitle: "Other", relation: "proposed" as const };

describe("SessionInbox (docs/328-session-message-inbox)", () => {
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let store: SessionInboxStore;
  let registry: SessionRunnerRegistry;
  let inbox: SessionInbox;
  let agents: FakeAgent[];
  let steering: boolean;
  let liveWork: boolean;
  let inline: boolean;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    sessionManager = new SessionManager(dbManager);
    sessionManager.track("parent", "Parent", "/tmp/parent");
    store = new SessionInboxStore(dbManager);
    agents = [];
    steering = false;
    liveWork = false;
    inline = false;

    const { deps } = makeDispatchTurnDeps(agents, []);
    // Echo the real prompt through, so the assertions read what the agent was given.
    deps.buildRunParams = vi.fn(async (_sessionId: string, _agentId: AgentId, prompt: string) => ({
      prompt,
      cwd: "/tmp/parent",
    })) as unknown as SystemTurnDeps["buildRunParams"];
    deps.inboxNotice = (sessionId) => prepareInboxNotice(store, sessionId, { inline });
    deps.steerInputs = () => ({ liveSteering: steering, steeringCapable: steering });

    registry = new SessionRunnerRegistry({
      onRunnerCreated: (runner) => runner.setSystemTurnDeps(deps),
      onRunnerIdle: (sessionId) => inbox.onRunnerIdle(sessionId),
    });
    inbox = new SessionInbox({
      store,
      sessionManager,
      runnerRegistry: registry,
      defaultAgentId: "claude",
      probeLiveWork: async () => liveWork,
    });
  });

  afterEach(() => {
    for (const id of ["parent", "second"]) registry.get(id)?.dispose({ force: true });
    dbManager.close();
    vi.restoreAllMocks();
  });

  const parent = () => sessionManager.get("parent")!;
  const ran = () => agents.filter((a) => a.run.mock.calls.length > 0);
  const promptOf = (agent: FakeAgent) => String((agent.run.mock.calls[0]?.[0] as { prompt?: string }).prompt);

  async function nextRun(count: number): Promise<string> {
    await waitForTurn(() => ran().length === count, `agent run ${count}`);
    return promptOf(ran()[count - 1]!);
  }

  async function endTurn(status: "success" | "error" = "success"): Promise<void> {
    const agent = ran().at(-1)!;
    const turns = ran().length;
    const idle = new Promise<void>((resolve) => registry.get("parent")!.once("idle", () => resolve()));
    agent.emit("event", { type: "agent_result", status, sessionId: "agent-sid" });
    agent.emit("done", 0);
    // The turn is over at its idle signal, or when a queued turn started with no idle between.
    await Promise.race([idle, waitForTurn(() => ran().length > turns, "the next turn")]);
    // The idle trigger tells in the background; let it finish before the test reads.
    await flushTurn();
  }

  /** A runner in a streaming turn that can take a steer, as `session-runner.test.ts` builds one. */
  function inStreamingTurn(): {
    runner: SessionRunnerInterface;
    sent: string[];
    setPermissionMode: ReturnType<typeof vi.fn>;
  } {
    steering = true;
    const runner = registry.getOrCreate("parent", "/tmp/parent", "claude");
    const sent: string[] = [];
    const setPermissionMode = vi.fn();
    runner.setAgent({ sendUserMessage: (text: string) => sent.push(text), setPermissionMode, kill: () => {} } as never);
    runner.running = true;
    noteTurnReady(runner);
    runner.isStreamingActive = true;
    return { runner, sent, setPermissionMode };
  }

  function endStreamingTurn(runner: SessionRunnerInterface): void {
    steering = false;
    runner.setAgent(null);
    runner.isStreamingActive = false;
    runner.running = false;
    inbox.onRunnerIdle("parent");
  }

  it("starts one short turn for an idle session, and the notice rides it (req 3)", async () => {
    const { told } = await inbox.post(parent(), { origin: CHILD, body: "the regen command is broken" });

    expect(told).toBe("started");
    const prompt = await nextRun(1);
    expect(prompt).toContain(buildInboxNotice(1));
    expect(prompt.endsWith(INBOX_TURN_TEXT)).toBe(true);
    // The message text is not in the turn: the agent reads the inbox for it (req 1).
    expect(prompt).not.toContain("the regen command is broken");

    await endTurn();
    expect(store.owed("parent")).toBeUndefined();
    expect(ran()).toHaveLength(1);
  });

  it("stores for a sender that tells later, and starts nothing until it does", async () => {
    const alongside = vi.fn();
    inbox.add("parent", { body: "Child PR #7 merged." }, alongside);
    await flushTurn();

    expect(alongside).toHaveBeenCalledTimes(1);
    expect(store.owed("parent")).toMatchObject({ unread: 1 });
    expect(ran()).toHaveLength(0);

    expect(await inbox.tell("parent")).toBe("started");
    expect(await nextRun(1)).toContain(buildInboxNotice(1));
  });

  it("gives a busy session one turn for all the messages that arrived, not one for each (req 1, req 5)", async () => {
    const runner = registry.getOrCreate("parent", "/tmp/parent", "claude");
    runner.dispatch(testDispatch({ text: "the user's own work" }));
    expect(await nextRun(1)).toBe("the user's own work");

    for (const body of ["report one", "report two", "report three"]) {
      expect((await inbox.post(parent(), { origin: CHILD, body })).told).toBe("later");
    }
    expect(runner.queueLength).toBe(0);

    await endTurn();
    const prompt = await nextRun(2);
    expect(prompt).toContain(buildInboxNotice(3));
    expect(inbox.read("parent").map((m) => m.id)).toHaveLength(3);

    await endTurn();
    expect(ran()).toHaveLength(2);
  });

  it("rides a turn that the user queued, and then starts no turn of its own", async () => {
    const runner = registry.getOrCreate("parent", "/tmp/parent", "claude");
    runner.dispatch(testDispatch({ text: "first" }));
    await nextRun(1);
    await inbox.post(parent(), { origin: CHILD, body: "a report" });
    runner.dispatch(testDispatch({ text: "the user's next message" }));

    await endTurn();
    const prompt = await nextRun(2);
    expect(prompt).toContain(buildInboxNotice(1));
    expect(prompt.endsWith("the user's next message")).toBe(true);

    await endTurn();
    expect(store.owed("parent")).toBeUndefined();
    expect(ran()).toHaveLength(2);
  });

  it("steers the notice into a streaming turn, one time until the agent reads (req 7)", async () => {
    const { sent } = inStreamingTurn();

    expect((await inbox.post(parent(), { origin: CHILD, body: "one" })).told).toBe("steered");
    expect((await inbox.post(parent(), { origin: CHILD, body: "two" })).told).toBe("steered");
    expect(sent).toEqual([buildInboxNotice(1)]);

    expect(inbox.read("parent").map((m) => m.text)).toHaveLength(2);

    expect((await inbox.post(parent(), { origin: CHILD, body: "three" })).told).toBe("steered");
    expect(sent).toEqual([buildInboxNotice(1), buildInboxNotice(1)]);
  });

  it("leaves the running turn's permission mode as it is", async () => {
    const { runner, sent, setPermissionMode } = inStreamingTurn();
    runner.appliedPermissionMode = "plan";

    expect((await inbox.post(parent(), { origin: CHILD, body: "one" })).told).toBe("steered");

    expect(sent).toHaveLength(1);
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(runner.appliedPermissionMode).toBe("plan");
  });

  it("does not put a steered notice in the queue when the CLI did not take it", async () => {
    const { runner } = inStreamingTurn();
    await inbox.post(parent(), { origin: CHILD, body: "one" });

    expect(runner.steeredMessages.map((m) => m.text)).toEqual([buildInboxNotice(1)]);

    // The turn ends with no echo of the steer. A user's message in this state is queued again.
    const queued = requeueUndeliveredSteers(runner, () => {});

    expect(queued).toBe(0);
    expect(runner.queueLength).toBe(0);
    // The transcript keeps no notice that the agent did not get.
    expect(runner.steeredMessages).toEqual([]);
    // The notice is still owed, so the idle trigger gives the session its turn.
    endStreamingTurn(runner);
    expect(await nextRun(1)).toContain(buildInboxNotice(1));
  });

  it("gives the session one turn when the agent did not act on a steered notice, and then stops", async () => {
    const { runner, sent } = inStreamingTurn();
    await inbox.post(parent(), { origin: CHILD, body: "a report" });
    expect(sent).toHaveLength(1);

    endStreamingTurn(runner);
    expect(await nextRun(1)).toContain(buildInboxNotice(1));

    // The agent ends this turn too without a read. It was told; the message stays unread.
    await endTurn();
    expect(store.owed("parent")).toBeUndefined();
    expect(await inbox.tell("parent")).toBe("later");
    await inbox.sweep();
    expect(ran()).toHaveLength(1);
    expect(inbox.read("parent")).toHaveLength(1);
  });

  it("starts nothing when the steered notice was read before the turn ended", async () => {
    const { runner } = inStreamingTurn();
    await inbox.post(parent(), { origin: CHILD, body: "a report" });
    inbox.read("parent");

    endStreamingTurn(runner);
    await inbox.sweep();

    expect(ran()).toHaveLength(0);
  });

  it("waits before it tries again after a turn that did not reach the agent", async () => {
    await inbox.post(parent(), { origin: CHILD, body: "a report" });
    await nextRun(1);

    await endTurn("error");
    // The idle trigger ran at the end of that turn. No receipt, so the notice is still owed.
    expect(store.owed("parent")).toBeDefined();
    await inbox.sweep();
    expect(ran()).toHaveLength(1);

    const realNow = Date.now.bind(Date);
    let ahead = 61_000;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + ahead);
    await inbox.sweep();
    expect(await nextRun(2)).toContain(buildInboxNotice(1));

    // The second failure doubles the wait one time: two minutes, not four.
    await endTurn("error");
    ahead += 61_000;
    await inbox.sweep();
    expect(ran()).toHaveLength(2);
    ahead += 61_000;
    await inbox.sweep();
    await nextRun(3);
  });

  it("starts the next turn at once for a message that arrived during the turn it started", async () => {
    await inbox.post(parent(), { origin: CHILD, body: "first" });
    await nextRun(1);
    // The session's turn runs and cannot take a steer, so this one waits for the turn to end.
    expect((await inbox.post(parent(), { origin: CHILD, body: "second" })).told).toBe("later");

    // The turn ends with its receipt for "first". "second" is a new notice, not a retry.
    await endTurn();

    expect(await nextRun(2)).toContain(buildInboxNotice(2));
  });

  it("stays off a turn that a driver owns, and is still owed after it", async () => {
    store.add("parent", { origin: CHILD, body: "a report" });
    const runner = registry.getOrCreate("parent", "/tmp/parent", "claude");

    runner.dispatch(testDispatch({ text: "resolve the conflict in src/a.ts", postTurn: "none" }));

    expect(await nextRun(1)).toBe("resolve the conflict in src/a.ts");
    // The driver's turn carried no notice, so its end is no receipt for one.
    ran()[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    ran()[0]!.emit("done", 0);
    await waitForTurn(() => !runner.running, "the driver's turn ended");
    expect(store.owed("parent")).toMatchObject({ unread: 1, since: 0 });
  });

  it("starts no turn while the worker still has work that no runner shows", async () => {
    // After a restart: no runner, and a resident process with a background job.
    liveWork = true;

    expect((await inbox.post(parent(), { origin: CHILD, body: "a report" })).told).toBe("later");
    expect(registry.get("parent")).toBeUndefined();

    liveWork = false;
    await inbox.sweep();
    await nextRun(1);
  });

  it("starts no turn while the runner's own worker still runs a turn", async () => {
    const runner = registry.getOrCreate("parent", "/tmp/parent", "claude");
    let inFlight = true;
    runner.hasTurnInFlight = async () => inFlight;

    expect((await inbox.post(parent(), { origin: CHILD, body: "a report" })).told).toBe("later");
    expect(ran()).toHaveLength(0);

    inFlight = false;
    await inbox.sweep();
    await nextRun(1);
  });

  it("starts the session one time when two messages arrive together", async () => {
    let release!: (working: boolean) => void;
    const probing = new Promise<boolean>((resolve) => { release = resolve; });
    const slow = new SessionInbox({
      store,
      sessionManager,
      runnerRegistry: registry,
      defaultAgentId: "claude",
      probeLiveWork: () => probing,
    });

    const first = slow.post(parent(), { origin: CHILD, body: "one" });
    const second = slow.post(parent(), { origin: CHILD, body: "two" });
    release(false);

    expect([(await first).told, (await second).told].sort()).toEqual(["later", "started"]);
    expect(await nextRun(1)).toContain(buildInboxNotice(2));
    expect(ran()).toHaveLength(1);
  });

  it("counts one failure when two messages meet a session that cannot start", async () => {
    dbManager.db.prepare("UPDATE sessions SET workspace_dir = NULL WHERE id = ?").run("parent");
    vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: (working: boolean) => void;
    const probing = new Promise<boolean>((resolve) => { release = resolve; });
    const slow = new SessionInbox({
      store,
      sessionManager,
      runnerRegistry: registry,
      defaultAgentId: "claude",
      probeLiveWork: () => probing,
    });

    const first = slow.post(parent(), { origin: CHILD, body: "one" });
    const second = slow.post(parent(), { origin: CHILD, body: "two" });
    release(false);

    // One attempt, so one failure: two would double the wait for a single fault.
    expect([(await first).told, (await second).told].sort()).toEqual(["failed", "later"]);
  });

  describe("a container that is older than the running ShipIt", () => {
    const OLD = { get: () => ({ status: "running", workerBuildId: "old-build" }) } as never;
    let build: string | undefined;

    beforeEach(() => {
      build = process.env.SHIPIT_BUILD_ID;
      process.env.SHIPIT_BUILD_ID = "new-build";
      inline = true;
    });
    afterEach(() => {
      if (build === undefined) delete process.env.SHIPIT_BUILD_ID;
      else process.env.SHIPIT_BUILD_ID = build;
    });

    it("gets the messages in the notice, and its receipt marks them read", async () => {
      await inbox.post(parent(), { origin: CHILD, body: "the regen command is broken" });

      const prompt = await nextRun(1);
      expect(prompt).toContain("the regen command is broken");
      expect(prompt).toContain("Child");
      expect(store.unread("parent")).toHaveLength(1);

      await endTurn();
      expect(store.unread("parent")).toEqual([]);
      expect(inbox.read("parent", { all: true })).toHaveLength(1);
      expect(ran()).toHaveLength(1);
    });

    it("gets no steered notice: its agent cannot run the command, and a steer has no receipt", async () => {
      const { sent } = inStreamingTurn();
      const old = new SessionInbox({
        store,
        sessionManager,
        runnerRegistry: registry,
        defaultAgentId: "claude",
        containerManager: OLD,
      });

      expect((await old.post(parent(), { origin: CHILD, body: "a report" })).told).toBe("later");
      expect(sent).toEqual([]);
    });
  });

  it("starts no turn while the resident process has background work", async () => {
    const runner = registry.getOrCreate("parent", "/tmp/parent", "claude");
    runner.isStreamingActive = true;
    runner.setBackgroundTasks([{ id: "task-1", description: "a long build" }]);

    expect((await inbox.post(parent(), { origin: CHILD, body: "a report" })).told).toBe("later");
    expect(ran()).toHaveLength(0);

    runner.clearBackgroundTasks();
    await inbox.sweep();
    await nextRun(1);
  });

  it("starts the session when its runner says running but its container is gone", async () => {
    const stale = registry.getOrCreate("parent", "/tmp/parent", "claude");
    stale.running = true;
    const withContainers = new SessionInbox({
      store,
      sessionManager,
      runnerRegistry: registry,
      defaultAgentId: "claude",
      containerManager: { get: () => undefined } as never,
    });

    expect((await withContainers.post(parent(), { origin: CHILD, body: "a report" })).told).toBe("started");
    expect(stale.disposed).toBe(true);
    expect(await nextRun(1)).toContain(buildInboxNotice(1));
  });

  it("starts no automatic turn while the agent waits for the user's answer, and saves none (docs/322)", async () => {
    sessionManager.setAwaitingAnswer("parent", true);

    expect((await inbox.post(parent(), { origin: CHILD, body: "a report" })).told).toBe("later");
    expect(registry.get("parent")).toBeUndefined();
    expect(sessionManager.heldTurns("parent")).toEqual([]);

    // A message the user approved is not automatic work, so it does not wait (docs/322 req 6).
    expect((await inbox.post(parent(), { origin: APPROVED, body: "approved by the user" })).told).toBe("started");
    expect(await nextRun(1)).toContain(buildInboxNotice(2));
  });

  it("tells every session that is owed a notice from the sweep", async () => {
    sessionManager.track("second", "Second", "/tmp/second");
    store.add("parent", { origin: CHILD, body: "stored before a restart" });
    store.add("second", { origin: CHILD, body: "stored before a restart" });

    await inbox.sweep();

    await waitForTurn(() => ran().length === 2, "both sessions started");
    expect(registry.get("parent")?.running).toBe(true);
    expect(registry.get("second")?.running).toBe(true);
  });

  it("tells nobody about a session that is archived", async () => {
    sessionManager.archive("parent");

    expect((await inbox.post(parent(), { origin: CHILD, body: "a report" })).told).toBe("later");
    expect(registry.get("parent")).toBeUndefined();
  });

  it("frames an agent's text with its sender and leaves ShipIt's own text bare", async () => {
    store.add("parent", { origin: CHILD, body: "from the child's agent" });
    store.add("parent", { body: "Child PR #7 merged" });

    const [fromAgent, fromShipIt] = inbox.read("parent");
    expect(fromAgent!.from).toEqual(CHILD);
    expect(fromAgent!.text).toContain("from the child's agent");
    expect(fromAgent!.text).not.toBe("from the child's agent");
    expect(fromAgent!.text).toContain("Child");
    expect(fromShipIt!.from).toBeUndefined();
    expect(fromShipIt!.text).toBe("Child PR #7 merged");

    expect(inbox.read("parent")).toEqual([]);
    expect(inbox.read("parent", { all: true })).toHaveLength(2);
  });
});
