// docs/333-idle-compaction — the cache lifetime, the deadline, and the fire, against a real
// usage store, a real runner and the real dispatched-turn path, with fake agents.
import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import type { AgentId, CompactionCard, SessionInfo } from "../../shared/types.js";
import { UsageManager } from "../usage.js";
import { SessionRunnerRegistry, type QueuedMessage, type SystemTurnDeps } from "../session-runner.js";
import type { PersistedMessage } from "../chat-history.js";
import { MISSED_COMPACTION_NOTICE } from "../compact-before-turn.js";
import {
  makeDispatchTurnDeps,
  makeFakeAgent,
  flushTurn,
  testDispatch,
  waitForTurn,
  type FakeAgent,
} from "../integration_tests/dispatch-test-helpers.js";
import { GLOBAL_SETTINGS } from "../../shared/settings-catalogue/global-settings.js";
import {
  IdleCompaction,
  cacheLifetimeMinutes,
  idleCompactionExclusion,
  type IdleCompactionDeps,
} from "./idle-compaction.js";

const SESSION = "idle-session";
const MINUTE = 60_000;
const LARGE = 250_000;

interface Setup {
  agentId?: AgentId;
  enabled?: () => boolean;
  liveSteering?: boolean;
  container?: "running" | "none" | "standby" | "local";
  session?: Partial<SessionInfo>;
}

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.useRealTimers();
});

function setup(opts: Setup = {}) {
  const db = new DatabaseManager(":memory:");
  const usage = new UsageManager(db);
  const sessions = new Map<string, SessionInfo>();
  const session = {
    id: SESSION,
    title: "Idle work",
    createdAt: new Date(Date.now() - 120 * MINUTE).toISOString(),
    lastUsedAt: new Date(Date.now() - 60 * MINUTE).toISOString(),
    workspaceDir: "/tmp/ws",
    agentId: opts.agentId ?? "codex",
    ...opts.session,
  } as SessionInfo;
  sessions.set(SESSION, session);
  const cards = new Map<string, CompactionCard>();
  const notices: PersistedMessage[] = [];

  const agents: FakeAgent[] = [];
  const appended: { role?: string; text?: string }[] = [];
  const { deps: turnDeps, sseBroadcast } = makeDispatchTurnDeps(agents, appended);
  const prompts: string[] = [];
  const compactFlags: (boolean | undefined)[] = [];
  turnDeps.buildRunParams = vi.fn(async (_sid, _agentId, prompt, _route, buildOpts) => {
    prompts.push(prompt);
    compactFlags.push(buildOpts?.compact);
    return { prompt, cwd: "/tmp/ws" } as never;
  });
  const hold = { awaiting: false, held: [] as QueuedMessage[], writes: [] as boolean[] };
  turnDeps.answerHold = {
    automaticTurnsHeld: () => hold.awaiting,
    setAwaitingAnswer: (_id: string, value: boolean) => {
      hold.writes.push(value);
      const changed = hold.awaiting !== value;
      hold.awaiting = value;
      return changed;
    },
    holdTurn: (_id: string, entry: QueuedMessage) => { hold.held.push({ ...entry, heldId: hold.held.length + 1 }); },
    heldTurns: () => [...hold.held],
    forgetHeldTurn: (heldId: number) => { hold.held = hold.held.filter((m) => m.heldId !== heldId); },
    hasHeldDelivery: () => false,
  } as unknown as SystemTurnDeps["answerHold"];
  const listenerSessions = turnDeps.listenerDeps.sessionManager as unknown as Record<string, ReturnType<typeof vi.fn>>;
  listenerSessions.setLastTurnOutcome = vi.fn();
  turnDeps.onTurnEnd = vi.fn();

  const registry = new SessionRunnerRegistry({
    onRunnerCreated: (r) => r.setSystemTurnDeps(turnDeps),
  });
  const containerStatus = opts.container ?? "running";
  const deps: IdleCompactionDeps = {
    isEnabled: opts.enabled ?? (() => true),
    liveSteering: () => opts.liveSteering ?? true,
    defaultAgentId: "claude",
    sessionManager: { get: (id: string) => sessions.get(id), listAll: () => [...sessions.values()] } as never,
    usageManager: usage,
    chatHistoryManager: {
      latestCompactionCard: (id: string) => cards.get(id),
      append: (_id: string, message: PersistedMessage) => { notices.push(message); },
    },
    runnerRegistry: registry,
    containerManager: containerStatus === "local"
      ? null
      : {
          get: () => (containerStatus === "none" ? undefined : { status: "running" }),
          isStandby: () => containerStatus === "standby",
        } as never,
  };
  const idle = new IdleCompaction(deps);
  usage.onAnchoredTurn((turn) => idle.arm(turn));
  cleanup.push(() => {
    idle.stop();
    registry.get(SESSION)?.dispose({ force: true });
    db.close();
  });

  /** The scope the result listener writes: the harness and model that read the cache. */
  const scope = () => ({ agentId: session.agentId ?? ("claude" as const), model: session.model ?? null });
  const anchorOf = (agoMs = 0) => ({ ...scope(), at: Date.now() - agoMs });
  /** An ordinary turn's row, as the result listener writes it. */
  const turn = (o: {
    context?: number; ttl?: "5m" | "1h" | null; anchorAgo?: number | null; route?: string;
  } = {}) => {
    usage.record(SESSION, 0, 1000, 10, 5, {
      contextTokens: o.context ?? LARGE,
      cacheScope: scope(),
      ...(o.ttl === null ? {} : { cacheTtl: o.ttl ?? "1h" }),
      ...(o.anchorAgo === null ? {} : { cacheAnchorAt: Date.now() - (o.anchorAgo ?? MINUTE) }),
      ...(o.route ? { credentialRouteId: o.route } : {}),
    });
  };

  return {
    idle, usage, session, sessions, cards, notices, registry, agents, appended, prompts, compactFlags,
    turnDeps, sseBroadcast, hold, listenerSessions, turn, anchorOf,
  };
}

describe("cacheLifetimeMinutes (req 1, 9, 10, 11)", () => {
  it("reads the observed 5m/1h split first", () => {
    expect(cacheLifetimeMinutes({ agentId: "claude", family: "claude", observed: "1h" })).toBe(60);
    expect(cacheLifetimeMinutes({ agentId: "claude", family: "claude", observed: "5m" })).toBe(5);
    expect(cacheLifetimeMinutes({ agentId: "codex", family: "gpt", observed: "5m" })).toBe(5);
  });

  it("falls back to the model vendor's documented lifetime, not the harness's", () => {
    expect(cacheLifetimeMinutes({ agentId: "opencode", family: "claude", observed: undefined })).toBe(5);
    expect(cacheLifetimeMinutes({ agentId: "codex", family: "kimi", observed: undefined })).toBe(5);
    expect(cacheLifetimeMinutes({ agentId: "codex", family: "gpt", observed: undefined })).toBe(30);
  });

  it("assumes 30 minutes where nothing is known (req 10)", () => {
    for (const family of ["glm", "deepseek", "grok", "qwen", undefined] as const) {
      expect(cacheLifetimeMinutes({ agentId: "codex", family, observed: undefined })).toBe(30);
    }
    expect(cacheLifetimeMinutes({ agentId: "claude", family: "claude", observed: undefined })).toBe(30);
  });
});

describe("idleCompactionExclusion", () => {
  it("excludes Grok (req 15) and a harness that cannot compact; OpenCode is in since planning#701 (req 14)", () => {
    expect(idleCompactionExclusion("grok")).toContain("req 15");
    expect(idleCompactionExclusion("antigravity")).not.toBeNull();
    expect(idleCompactionExclusion("opencode")).toBeNull();
    expect(idleCompactionExclusion("claude")).toBeNull();
    expect(idleCompactionExclusion("codex")).toBeNull();
  });
});

describe("the setting (req 5)", () => {
  it("is off by default", () => {
    expect(GLOBAL_SETTINGS["advanced.idleCompaction"].type.read(undefined)).toBe(false);
    expect(GLOBAL_SETTINGS["advanced.idleCompaction"].tab).toBe("advanced");
  });
});

describe("arming the deadline (req 1, 6, 11)", () => {
  it("arms at 90% of the lifetime, from the turn's last request, for a context of 200K or more", () => {
    vi.useFakeTimers();
    const { idle, turn } = setup();
    turn({ context: 200_000, anchorAgo: 0 });
    expect(idle.isWaiting(SESSION)).toBe(true);
    const fire = vi.spyOn(idle, "fire");

    vi.advanceTimersByTime(54 * MINUTE - 1_000);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(fire).toHaveBeenCalledWith(SESSION);
    expect(idle.isWaiting(SESSION)).toBe(false);
  });

  it("arms nothing under 200K, or without any context reading (req 6)", () => {
    const { idle, turn } = setup();
    turn({ context: 199_999 });
    expect(idle.isWaiting(SESSION)).toBe(false);

    const bare = setup();
    bare.idle.arm({ sessionId: SESSION, anchor: bare.anchorOf(), credentialRouteId: null });
    expect(bare.idle.isWaiting(SESSION)).toBe(false);
  });

  it("arms nothing on a cache that lives under 30 minutes (req 11)", () => {
    const { idle, turn } = setup({ agentId: "claude", liveSteering: false });
    turn({ ttl: "5m" });
    expect(idle.isWaiting(SESSION)).toBe(false);

    const kimi = setup({ session: { model: "moonshotai/kimi-k3", serviceId: "openrouter", billingMode: "key" } });
    kimi.turn({ ttl: null });
    expect(kimi.idle.isWaiting(SESSION)).toBe(false);
  });

  it("assumes 30 minutes where no lifetime is observed (req 10)", () => {
    vi.useFakeTimers();
    const { idle, turn } = setup();
    turn({ ttl: null, anchorAgo: 0 });
    const fire = vi.spyOn(idle, "fire");
    vi.advanceTimersByTime(27 * MINUTE + 1_000);
    expect(fire).toHaveBeenCalledWith(SESSION);
  });

  it("reads the lifetime observed on the turn's own route", () => {
    const { idle, turn } = setup();
    turn({ ttl: "1h", route: "anthropic-sub", anchorAgo: null });
    turn({ ttl: "5m", route: "anthropic-key" });
    expect(idle.isWaiting(SESSION)).toBe(false);
    turn({ ttl: null, route: "anthropic-sub" });
    expect(idle.isWaiting(SESSION)).toBe(true);
  });

  it("does not take a lifetime another harness or model saw on the same credential", () => {
    const { idle, turn, session } = setup({ agentId: "claude", liveSteering: false });
    turn({ ttl: "5m", route: "gateway", anchorAgo: null });
    Object.assign(session, { agentId: "opencode", model: "gpt-6-luna", serviceId: "openai", billingMode: "sub" });
    turn({ ttl: null, route: "gateway" });
    expect(idle.isWaiting(SESSION)).toBe(true);
  });

  it("gives Grok, and a harness that cannot compact, no deadline (req 15)", () => {
    for (const agentId of ["grok", "antigravity"] as const) {
      const { idle, turn } = setup({ agentId });
      turn();
      expect(idle.isWaiting(SESSION)).toBe(false);
    }
  });

  it("arms OpenCode on an OpenAI model, and not on Anthropic's 5-minute default (req 9, 11, 14)", () => {
    const openai = setup({ agentId: "opencode", session: { model: "gpt-6-luna", serviceId: "openai", billingMode: "sub" } });
    openai.turn({ ttl: null });
    expect(openai.idle.isWaiting(SESSION)).toBe(true);

    const anthropic = setup({
      agentId: "opencode", session: { model: "claude-sonnet-5-5", serviceId: "anthropic", billingMode: "key" },
    });
    anthropic.turn({ ttl: null });
    expect(anthropic.idle.isWaiting(SESSION)).toBe(false);
  });

  it("is replaced by the next turn's reading, and dropped by a small one", () => {
    vi.useFakeTimers();
    const { idle, turn } = setup();
    turn({ anchorAgo: 0 });
    const fire = vi.spyOn(idle, "fire");
    vi.advanceTimersByTime(30 * MINUTE);
    turn({ anchorAgo: 0 });
    vi.advanceTimersByTime(30 * MINUTE);
    expect(fire).not.toHaveBeenCalled();
    turn({ context: 40_000 });
    vi.advanceTimersByTime(60 * MINUTE);
    expect(fire).not.toHaveBeenCalled();
  });

  it("counts a newer compaction card as the context: just compacted is small", () => {
    const { idle, cards, turn } = setup();
    cards.set(SESSION, { id: "c1", createdAt: new Date(Date.now() + 5_000).toISOString(), postTokens: 9_000 });
    turn();
    expect(idle.isWaiting(SESSION)).toBe(false);
  });

  it("arms nothing for a cache that has already expired", () => {
    const { idle, turn } = setup();
    turn({ anchorAgo: 61 * MINUTE });
    expect(idle.isWaiting(SESSION)).toBe(false);
  });
});

describe("re-deriving at boot", () => {
  it("arms from the newest anchored turn younger than the longest lifetime", () => {
    const { idle, turn, usage } = setup();
    turn({ anchorAgo: 10 * MINUTE });
    // A compaction that failed: zero usage, no anchor, no card. Boot tries it once more.
    usage.record(SESSION, 0, 500, 0, 0);
    const restarted = new IdleCompaction((idle as unknown as { deps: IdleCompactionDeps }).deps);
    cleanup.push(() => restarted.stop());
    restarted.rederive();
    expect(restarted.isWaiting(SESSION)).toBe(true);
  });

  it("arms nothing after a compaction that succeeded", () => {
    const { idle, turn, cards } = setup();
    turn({ anchorAgo: 10 * MINUTE });
    cards.set(SESSION, { id: "c1", createdAt: new Date(Date.now() + 5_000).toISOString(), postTokens: 12_000 });
    const restarted = new IdleCompaction((idle as unknown as { deps: IdleCompactionDeps }).deps);
    cleanup.push(() => restarted.stop());
    restarted.rederive();
    expect(restarted.isWaiting(SESSION)).toBe(false);
  });

  it("arms nothing from a turn on a model the session has since left", () => {
    const { idle, turn, session } = setup({ session: { model: "gpt-6-luna", serviceId: "openai", billingMode: "sub" } });
    turn({ anchorAgo: 10 * MINUTE });
    session.model = "gpt-6.1-sol";
    const restarted = new IdleCompaction((idle as unknown as { deps: IdleCompactionDeps }).deps);
    cleanup.push(() => restarted.stop());
    restarted.rederive();
    expect(restarted.isWaiting(SESSION)).toBe(false);
  });
});

describe("firing — what drops it", () => {
  it("takes the attempt first: a second fire does nothing, also after the setting comes on", async () => {
    let enabled = false;
    const { idle, turn, agents } = setup({ enabled: () => enabled });
    turn();
    await idle.fire(SESSION);
    enabled = true;
    await idle.fire(SESSION);
    await flushTurn();
    expect(agents).toHaveLength(0);
  });

  it.each([
    ["the session is archived", { userArchived: true }],
    ["the session is done (req 7)", {
      mergedAt: new Date(Date.now() - 30 * MINUTE).toISOString(),
      lastUsedAt: new Date(Date.now() - 60 * MINUTE).toISOString(),
    }],
    ["a rewind waits for the next turn", { agentResumeAt: "msg-12" }],
  ] as [string, Partial<SessionInfo>][])("drops it when %s", async (_label, change) => {
    const { idle, turn, session, agents } = setup();
    turn();
    Object.assign(session, change);
    await idle.fire(SESSION);
    await flushTurn();
    expect(agents).toHaveLength(0);
  });

  it("drops it when the harness or the model changed", async () => {
    for (const change of [{ agentId: "claude" as const }, { model: "gpt-6-luna" }]) {
      const { idle, turn, session, agents } = setup();
      turn();
      Object.assign(session, change);
      await idle.fire(SESSION);
      await flushTurn();
      expect(agents).toHaveLength(0);
    }
  });

  it("never compacts a cold cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { idle, turn, agents } = setup();
    turn({ anchorAgo: 0 });
    vi.setSystemTime(Date.now() + 61 * MINUTE);
    await idle.fire(SESSION);
    vi.useRealTimers();
    await flushTurn();
    expect(agents).toHaveLength(0);
  });

  it.each(["none", "standby"] as const)("starts no container, with the container %s (req 13)", async (container) => {
    const { idle, turn, agents, registry } = setup({ container });
    turn();
    await idle.fire(SESSION);
    await flushTurn();
    expect(agents).toHaveLength(0);
    expect(registry.get(SESSION)).toBeUndefined();
  });

  it("is refused while a turn runs, a flow holds the session, or the resident has background work", async () => {
    const cases: ((r: ReturnType<SessionRunnerRegistry["getOrCreate"]>) => void)[] = [
      (r) => { r.running = true; },
      (r) => { r.mergeHold = true; },
      (r) => {
        r.setAgent(makeFakeAgent() as never);
        r.isStreamingActive = true;
        r.setBackgroundTasks([{ id: "bg", description: "npm test" }]);
      },
    ];
    for (const makeBusy of cases) {
      const { idle, turn, agents, registry } = setup();
      const runner = registry.getOrCreate(SESSION, "/tmp/ws", "codex");
      makeBusy(runner);
      turn();
      expect(idle.isWaiting(SESSION)).toBe(false);
      await idle.fire(SESSION);
      await flushTurn();
      expect(agents).toHaveLength(0);
      runner.running = false;
    }
  });

  it("drops a Claude session whose resident process is gone, without creating a runner", async () => {
    const { idle, turn, agents, registry } = setup({ agentId: "claude" });
    turn();
    expect(idle.isWaiting(SESSION)).toBe(false);
    await idle.fire(SESSION);
    await flushTurn();
    expect(agents).toHaveLength(0);
    expect(registry.get(SESSION)).toBeUndefined();
  });

  it("checks again after reaching the runner", async () => {
    const { idle, turn, agents, registry, session } = setup();
    turn();
    const getOrCreate = registry.getOrCreate.bind(registry);
    vi.spyOn(registry, "getOrCreate").mockImplementation((...args) => {
      // The session became done while ShipIt reached its runner.
      session.mergedAt = new Date(Date.now() - MINUTE).toISOString();
      return getOrCreate(...args);
    });
    await idle.fire(SESSION);
    await flushTurn();
    expect(registry.getOrCreate).toHaveBeenCalled();
    expect(agents).toHaveLength(0);
  });

  it("drops it when the context was compacted since the reading (req 6)", async () => {
    const { idle, turn, cards, agents } = setup();
    turn();
    cards.set(SESSION, { id: "c1", createdAt: new Date(Date.now() + 5_000).toISOString(), postTokens: 9_000 });
    expect(idle.isWaiting(SESSION)).toBe(false);
    await idle.fire(SESSION);
    await flushTurn();
    expect(agents).toHaveLength(0);
  });
});

describe("firing — the compaction turn", () => {
  it("reaches the runner of a live container and runs a silent /compact turn (req 2, 3, 9)", async () => {
    const { idle, turn, agents, prompts, compactFlags, appended, registry } = setup();
    turn();
    await idle.fire(SESSION);
    await waitForTurn(() => prompts.length === 1, "compaction spawn");

    expect(registry.get(SESSION)).toBeDefined();
    expect(prompts[0]?.trim()).toBe("/compact");
    expect(compactFlags[0]).toBe(true);
    expect(agents).toHaveLength(1);
    expect(appended.filter((m) => m.role === "user")).toHaveLength(0);
  });

  it("runs Claude's compaction in the resident process that holds the warm cache", async () => {
    const { idle, turn, registry, agents } = setup({ agentId: "claude" });
    const runner = registry.getOrCreate(SESSION, "/tmp/ws", "claude");
    const resident = makeFakeAgent();
    runner.setAgent(resident as never);
    runner.isStreamingActive = true;
    turn();
    expect(idle.isWaiting(SESSION)).toBe(true);

    await idle.fire(SESSION);
    await waitForTurn(() => resident.sendUserMessage.mock.calls.length === 1, "the compaction entered the resident");
    expect(resident.sendUserMessage).toHaveBeenCalledWith("/compact", { silentCompaction: true });
    expect(resident.kill).not.toHaveBeenCalled();
    expect(agents).toHaveLength(0);
  });

  it("with live steering off, Claude's compaction is a resumed process like every turn", async () => {
    const { idle, turn, prompts } = setup({ agentId: "claude", liveSteering: false });
    turn();
    await idle.fire(SESSION);
    await waitForTurn(() => prompts.length === 1, "compaction spawn");
    expect(prompts[0]?.trim()).toBe("/compact");
  });

  it("is maintenance: no list move, no unmute, no turn outcome", async () => {
    const { idle, turn, agents, listenerSessions, turnDeps } = setup();
    turn();
    await idle.fire(SESSION);
    await waitForTurn(() => agents.length === 1, "compaction spawn");
    agents[0]?.emit("event", { type: "agent_compacted", preTokens: LARGE, postTokens: 9_000 });
    agents[0]?.emit("event", { type: "agent_result", status: "error", error: "boom", sessionId: "s" });
    agents[0]?.emit("done", 0);
    await flushTurn();

    expect(listenerSessions.track).not.toHaveBeenCalled();
    expect(listenerSessions.touchUnlessResolved).not.toHaveBeenCalled();
    expect(listenerSessions.setMuted).not.toHaveBeenCalled();
    expect(listenerSessions.setLastTurnOutcome).not.toHaveBeenCalled();
    expect(listenerSessions.setLastTurnErrored).not.toHaveBeenCalled();
    expect(turnDeps.onTurnEnd).not.toHaveBeenCalled();
  });

  it("runs while the agent waits for an answer, and the hold stays on (req 12)", async () => {
    const { idle, turn, hold, agents, prompts, registry } = setup();
    hold.awaiting = true;
    turn();
    expect(idle.isWaiting(SESSION)).toBe(true);
    await idle.fire(SESSION);
    await waitForTurn(() => prompts.length === 1, "compaction spawn");
    expect(hold.writes).not.toContain(false);

    const runner = registry.get(SESSION)!;
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "s" });
    agents[0]?.emit("done", 0);
    await waitForTurn(() => !runner.running, "compaction ended");
    expect(hold.awaiting).toBe(true);

    // Automatic work still waits for the user's own turn.
    runner.dispatch(testDispatch({ text: "CI failed — fix it", automatic: true }));
    await flushTurn();
    expect(prompts).toHaveLength(1);
    expect(hold.held.map((m) => m.text)).toEqual(["CI failed — fix it"]);

    // The user's answer releases the hold, and the held work runs after it.
    runner.dispatch(testDispatch({ text: "Use option B" }));
    await waitForTurn(() => prompts.length === 2, "the user's turn");
    expect(prompts[1]).toContain("Use option B");
    expect(hold.writes).toContain(false);
  });

  it("posts the missed-compaction notice when the dispatch fails (req 4)", async () => {
    const { idle, turn, notices, registry } = setup();
    const runner = registry.getOrCreate(SESSION, "/tmp/ws", "codex");
    vi.spyOn(runner, "dispatch").mockImplementation(() => { throw new Error("untrusted"); });
    turn();
    await idle.fire(SESSION);
    expect(notices.map((n) => n.text)).toContain(MISSED_COMPACTION_NOTICE);
  });

  it("posts the missed-compaction notice when the turn ends with no card (req 4)", async () => {
    const { idle, turn, agents, appended } = setup();
    turn();
    await idle.fire(SESSION);
    await waitForTurn(() => agents.length === 1, "compaction spawn");
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "s" });
    agents[0]?.emit("done", 0);
    await waitForTurn(() => appended.some((m) => m.text === MISSED_COMPACTION_NOTICE), "missed notice");
  });
});
