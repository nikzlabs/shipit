/**
 * docs/295 — the shared per-turn wiring of the merged-session context compaction.
 *
 * The eligibility GATE is `services/pre-turn-reset.test.ts`'s subject (this hook
 * asks the same `isResetEligible` on purpose, so re-testing the nine clauses
 * here would only duplicate them). What is tested here is what docs/295 adds:
 *
 *  - WHEN it runs at all — the setting, the per-send untick, the harness
 *    capability, eligibility, and the background-work refusal;
 *  - WHAT it runs — a SLOT-OWNING operation, not a turn: it must not publish a
 *    delivery, announce completion, mark the session running, or write a user
 *    row, because none of that belongs to a maintenance step nested inside
 *    someone else's send;
 *  - WHAT it reports — an outcome, never bare completion, so a backend that
 *    accepts the trigger and does nothing cannot be rendered as a success
 *    (req 9, and docs/276 req 2, which is the precedent).
 *
 * The seams are the ones the operation actually uses — `createAgent` and the
 * agent's own event channel, `prepareAgentEnv`, `buildRunParams` — rather than
 * a mocked turn executor. That is deliberate: the executor is no longer in this
 * path, and a test that still mocked it would pass while the real code did
 * something else entirely.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AgentEvent,
  AgentProcess,
  AgentRunParams,
  SessionInfo,
  WsServerMessage,
} from "../shared/types.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { GitManager } from "../shared/git.js";
import type { PersistedMessage } from "./chat-history.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";

const supportsCompaction = vi.fn<() => boolean>(() => true);
vi.mock("../shared/agent-registry.js", () => ({
  getAgentCapabilities: () => ({ supportsCompaction: supportsCompaction() }),
}));

const { applyPreTurnCompaction } = await import("./pre-turn-compact-hook.js");

const MERGED_SHA = "a1f3c9d0000000000000000000000000000000aa";
const BASE_TIP = "7e02b480000000000000000000000000000000bb";

beforeEach(() => {
  supportsCompaction.mockReset();
  supportsCompaction.mockReturnValue(true);
});

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Fix login redirect",
    createdAt: "2026-06-01T00:00:00.000Z",
    lastUsedAt: "2026-06-01T00:00:00.000Z",
    remoteUrl: "https://github.com/o/r.git",
    branch: "shipit/fix-login",
    mergedAt: "2026-06-02 12:00:00",
    mergedHeadSha: MERGED_SHA,
    ...over,
  } as SessionInfo;
}

function makePrStatus(): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 482,
    prUrl: "https://github.com/o/r/pull/482",
    prState: "merged",
    baseBranch: "main",
    headBranch: "shipit/fix-login",
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
  } as unknown as PrStatusSummary;
}

/** An eligible tree: merged, clean, HEAD still exactly at the merged commit. */
function makeGit(over: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
  return {
    isClean: vi.fn().mockResolvedValue(true),
    currentBranchOrNull: vi.fn().mockResolvedValue("shipit/fix-login"),
    isRebaseInProgress: vi.fn().mockResolvedValue(false),
    isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(false),
    getHeadHash: vi.fn().mockResolvedValue(MERGED_SHA),
    getRefHash: vi.fn().mockResolvedValue(BASE_TIP),
    isAncestor: vi.fn().mockResolvedValue(false),
    ...over,
  } as unknown as GitManager;
}

/**
 * What the compaction process does once the operation calls `run()`. Scripted
 * per test, because the one thing the hook cannot see for itself is whether the
 * backend actually compacted.
 */
type Script =
  | { kind: "compacts" }
  | { kind: "silent" }
  | { kind: "errors"; message: string }
  | { kind: "compacts-then-errors"; message: string }
  | { kind: "hangs" };

interface FakeAgent extends AgentProcess {
  runCalls: AgentRunParams[];
  killed: number;
}

function makeAgent(script: Script): FakeAgent {
  const listeners = new Map<string, ((...a: never[]) => void)[]>();
  const fire = (name: string, ...a: unknown[]): void => {
    for (const l of listeners.get(name) ?? []) (l as (...x: unknown[]) => void)(...a);
  };
  const agent = {
    agentId: "claude",
    runCalls: [] as AgentRunParams[],
    killed: 0,
    on(name: string, handler: (...a: never[]) => void) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      return this;
    },
    removeAllListeners() { listeners.clear(); return this; },
    emit: vi.fn(),
    kill() { (agent as FakeAgent).killed += 1; },
    run(params: AgentRunParams) {
      (agent as FakeAgent).runCalls.push(params);
      // Asynchronous, like a real spawn: the operation must be awaiting its
      // settle latch by the time anything arrives.
      queueMicrotask(() => {
        if (script.kind === "hangs") return;
        if (script.kind === "compacts" || script.kind === "compacts-then-errors") {
          fire("event", { type: "agent_compacted", preTokens: 19585, postTokens: 10335 } as AgentEvent);
        }
        fire("event", { type: "agent_result", status: "success", sessionId: "agent-after-compaction" } as AgentEvent);
        if (script.kind === "errors" || script.kind === "compacts-then-errors") {
          fire("error", new Error(script.message));
          return;
        }
        fire("done", 0);
      });
    },
  } as unknown as FakeAgent;
  return agent;
}

interface Harness {
  args: Parameters<typeof applyPreTurnCompaction>[0];
  emitted: WsServerMessage[];
  appended: PersistedMessage[];
  slot: { agent: AgentProcess | null };
  superseded: string[];
  killed: string[];
  agents: FakeAgent[];
  routesSeen: unknown[];
  sessionIdWrites: string[];
  holdSamples: boolean[];
  probes: string[];
}

function makeHarness(over: {
  session?: SessionInfo | undefined;
  git?: GitManager;
  setting?: boolean;
  intent?: boolean;
  resident?: boolean;
  backgroundWork?: string[];
  script?: Script;
  recheck?: boolean;
  /** Make `createAgent` throw, i.e. the container will not hand back a proxy. */
  createAgentThrows?: boolean;
  /** Make credential prep hang, i.e. a stall the timer cannot interrupt. */
  envPrepHangs?: boolean;
  /** What routing selected for this spawn, as `prepareAgentEnv` reports it. */
  turnRoute?: { kind: string; id: string };
} = {}): Harness {
  const emitted: WsServerMessage[] = [];
  const appended: PersistedMessage[] = [];
  const superseded: string[] = [];
  const killed: string[] = [];
  const agents: FakeAgent[] = [];
  const sessionIdWrites: string[] = [];
  const holdSamples: boolean[] = [];
  const probes: string[] = [];
  const routesSeen: unknown[] = [];
  const session = "session" in over ? over.session : makeSession();

  const residentAgent = over.resident
    ? ({
        agentId: "claude",
        on: vi.fn(),
        removeAllListeners: vi.fn(),
        emit: (name: string) => { superseded.push(`resident:${name}`); },
        kill: () => { killed.push("resident"); },
      } as unknown as AgentProcess)
    : null;

  const slot: { agent: AgentProcess | null } = { agent: residentAgent };

  const runner = {
    sessionId: "s1",
    sessionDir: "/w/s1",
    emitMessage: (msg: WsServerMessage) => { emitted.push(msg); },
    getAgent: () => slot.agent,
    setAgent: (a: AgentProcess | null) => { slot.agent = a; },
    isStreamingActive: over.resident ?? false,
    backgroundWorkDescriptions: over.backgroundWork ?? [],
    systemTurnInProgress: false,
    activeDeliveryId: undefined,
    // TRUE, because that is what both real callers do before this hook is
    // reached: `send-message.ts` sets it right before `runAgentWithMessage`,
    // and `dispatchOnRunner` sets it in the same synchronous tick as the
    // delivery. A harness that manufactured `false` here made every assertion
    // about card persistence blind — and did, until the third review found the
    // card being deleted in production shape.
    running: true,
    preTurnHold: false,
    chatMessageGroups: [],
    recordedCards: [],
    steeredMessages: [],
    getTurnEventBuffer: () => [],
    lastPersistedBufferIndex: 0,
  } as unknown as SessionRunnerInterface;

  const turnDeps = {
    listenerDeps: {
      sessionManager: {
        setAgentSessionId: (_sid: string, agentSessionId: string) => {
          sessionIdWrites.push(agentSessionId);
        },
      },
    },
    prepareAgentEnv: over.envPrepHangs
      ? () => new Promise<never>(() => { /* never resolves */ })
      : vi.fn().mockResolvedValue(over.turnRoute ? { turnRoute: over.turnRoute } : undefined),
    buildRunParams: (
      _sid: string, _aid: string, prompt: string, route: unknown, opts?: { compact?: boolean },
    ) => {
      if (route !== undefined) routesSeen.push(route);
      // Sampled at the moment of the spawn: the hold must be up by then, or a
      // message arriving during credential prep is admitted alongside this.
      holdSamples.push(runner.preTurnHold);
      return Promise.resolve({
        prompt, cwd: "/w/s1", ...(opts?.compact ? { compact: true } : {}),
      } as AgentRunParams);
    },
  } as unknown as SystemTurnDeps;

  const args: Parameters<typeof applyPreTurnCompaction>[0] = {
    deps: {
      getSession: () => session,
      getPrStatus: () => makePrStatus(),
      createGitManager: () => over.git ?? makeGit(),
      chatHistoryManager: {
        replaceInProgress: vi.fn(),
        append: (_sid: string, msg: PersistedMessage) => { appended.push(msg); },
      },
      getAutoResetMergedBranch: () => over.setting ?? true,
      ...(over.recheck
        ? {
            mergeRecheckDeps: {
              verifyPrState: () => { probes.push("verify"); return Promise.resolve(); },
              awaitMergeHandling: () => Promise.resolve(),
            },
          }
        : {}),
    } as unknown as Parameters<typeof applyPreTurnCompaction>[0]["deps"],
    turnDeps,
    runner,
    agentId: "claude",
    sessionId: "s1",
    sessionDir: "/w/s1",
    createAgent: () => {
      if (over.createAgentThrows) throw new Error("container unreachable");
      const a = makeAgent(over.script ?? { kind: "compacts" });
      agents.push(a);
      return a;
    },
    ...(over.intent !== undefined ? { intent: over.intent } : {}),
  };

  return {
    args, emitted, appended, slot, superseded, killed, agents, routesSeen,
    sessionIdWrites, holdSamples, probes,
  };
}

describe("applyPreTurnCompaction — when it runs at all", () => {
  it("does nothing when the shared setting is off (req 11)", async () => {
    const h = makeHarness({ setting: false });
    expect((await applyPreTurnCompaction(h.args)).outcome).toEqual({ kind: "not-applicable" });
    expect(h.agents).toHaveLength(0);
  });

  it("does nothing when the user unticked the control for this message (req 5)", async () => {
    const h = makeHarness({ intent: false });
    expect((await applyPreTurnCompaction(h.args)).outcome).toEqual({ kind: "not-applicable" });
    expect(h.agents).toHaveLength(0);
  });

  it("does nothing when the backend cannot compact (req 10)", async () => {
    supportsCompaction.mockReturnValue(false);
    const h = makeHarness();
    expect((await applyPreTurnCompaction(h.args)).outcome).toEqual({ kind: "not-applicable" });
    expect(h.agents).toHaveLength(0);
  });

  it("does nothing on a session that is not reset-eligible (reqs 1 and 3)", async () => {
    // Not merged: the ordinary state of nearly every session, and the state in
    // which the composer offers neither control.
    const h = makeHarness({ session: makeSession({ mergedAt: undefined }) });
    expect((await applyPreTurnCompaction(h.args)).outcome).toEqual({ kind: "not-applicable" });
    expect(h.agents).toHaveLength(0);
  });

  it("does nothing when the branch has moved past the merge, so a reset would be refused", async () => {
    const h = makeHarness({
      git: makeGit({ getHeadHash: vi.fn().mockResolvedValue("cafe0000000000000000000000000000000000ff") }),
    });
    expect((await applyPreTurnCompaction(h.args)).outcome).toEqual({ kind: "not-applicable" });
    expect(h.agents).toHaveLength(0);
  });

  it("runs with no per-send intent at all — the programmatic path (req 13)", async () => {
    const h = makeHarness(); // no `intent` key: a dispatch carries no tick box
    expect((await applyPreTurnCompaction(h.args)).outcome).toEqual({ kind: "compacted" });
  });

  it("runs when only the compaction was ticked — it is never told the reset's intent (req 6)", async () => {
    const h = makeHarness({ intent: true });
    expect((await applyPreTurnCompaction(h.args)).outcome).toEqual({ kind: "compacted" });
  });

  it("skips rather than killing a resident that holds background work", async () => {
    // docs/260 req 13 — `dispatchOnRunner` refuses to let a system turn displace
    // such a process by enqueuing it. This operation cannot enqueue (it has to
    // finish before the user's turn is assembled), so it stands down. Losing one
    // compaction is a far smaller harm than losing a running review.
    const h = makeHarness({ resident: true, backgroundWork: ["reviewing the diff"] });
    expect((await applyPreTurnCompaction(h.args)).outcome).toEqual({ kind: "not-applicable" });
    expect(h.agents).toHaveLength(0);
    expect(h.killed).toEqual([]);
  });
});

describe("applyPreTurnCompaction — it is an operation, not a turn", () => {
  it("never marks the session running, and announces no completion", async () => {
    // The whole reason this stopped going through `executeAgentTurn`. A turn
    // that "finished" here would tell `shipit session wait` the session is
    // ready, and tell a redelivery supervisor the work was delivered, before
    // the user's message has run at all.
    const h = makeHarness();
    await applyPreTurnCompaction(h.args);
    // The caller owns `running` and had already set it; what matters is that
    // this operation never CLEARS it (announcing a completion the user's turn
    // has not reached) and never publishes a delivery of its own.
    expect(h.args.runner.running).toBe(true);
    expect(h.args.runner.activeDeliveryId).toBeUndefined();
    expect(h.args.runner.systemTurnInProgress).toBe(false);
    const kinds = h.emitted.map((m) => m.type);
    expect(kinds).not.toContain("session_status");
  });

  it("holds the session against a second turn for the WHOLE operation", async () => {
    // Not just the compaction: the merge probe is a network round-trip and the
    // eligibility check reads git, and during those the session is idle by
    // every measure a caller consults.
    const h = makeHarness();
    const pending = applyPreTurnCompaction(h.args);
    expect(h.args.runner.preTurnHold).toBe(true);
    await pending;
    // …and gives it back, or every later message in the session is queued
    // forever.
    expect(h.args.runner.preTurnHold).toBe(false);
    // Up before the spawn, too — a message arriving during credential prep
    // would otherwise start alongside it.
    expect(h.holdSamples).toEqual([true]);
  });

  it("gives the hold back even when the agent cannot be created", async () => {
    const h = makeHarness({ createAgentThrows: true });
    const result = await applyPreTurnCompaction(h.args);
    expect(result.outcome).toEqual({ kind: "failed", detail: "container unreachable" });
    // Stuck true, this queues every later message in the session forever.
    expect(h.args.runner.preTurnHold).toBe(false);
  });

  it("does not fake a user message", async () => {
    // ShipIt started this, not the user. A `/compact` bubble or a user row
    // would put a command nobody typed into the transcript.
    const h = makeHarness();
    await applyPreTurnCompaction(h.args);
    expect(h.appended.filter((m) => m.role === "user")).toEqual([]);
    expect(h.emitted.map((m) => m.type)).not.toContain("system_user_message");
  });

  it("spawns with the compaction flag and the post-merge instructions", async () => {
    const h = makeHarness();
    await applyPreTurnCompaction(h.args);
    const params = h.agents[0]!.runCalls[0]!;
    // Without the flag the adapter runs `/compact …` as an ordinary prompt.
    expect(params.compact).toBe(true);
    expect(params.prompt.startsWith("/compact ")).toBe(true);
    expect(params.prompt).toContain("merged");
  });

  it("writes back the agent session id the compaction left behind", async () => {
    // A compaction can leave the backend on a new session id, and a stale id
    // would resume the pre-compaction conversation — throwing the whole
    // compaction away on the very turn it exists to help.
    const h = makeHarness();
    await applyPreTurnCompaction(h.args);
    expect(h.sessionIdWrites).toEqual(["agent-after-compaction"]);
  });

  it("retires and settles a resident process, then hands the slot back empty", async () => {
    const h = makeHarness({ resident: true });
    await applyPreTurnCompaction(h.args);
    // planning#318 — settling first is what stops the retired turn looking like a
    // delivery that never happened, which a supervisor would re-deliver.
    expect(h.superseded).toEqual(["resident:superseded"]);
    expect(h.killed).toEqual(["resident"]);
    // The user's turn resolves its own agent right after this returns; a spent
    // proxy left installed would own the SSE routing its events depend on.
    expect(h.slot.agent).toBeNull();
  });

  it("persists the compaction card durably, even though the caller marks the session running", async () => {
    // The card is created OUTSIDE a turn, so it has to be final when written —
    // there is no turn boundary coming that will finalize it. Routed through
    // `emitChatCard` it would take the in-progress branch (both callers set
    // `running` before this hook) and the user's turn would delete it at its
    // first `replaceInProgress`: rendered live, gone on reload.
    const h = makeHarness();
    expect(h.args.runner.running).toBe(true); // the production shape
    await applyPreTurnCompaction(h.args);
    expect(h.appended.filter((m) => m.compaction !== undefined)).toHaveLength(1);
    expect(h.args.runner.recordedCards ?? []).toEqual([]); // NOT in-band
    expect(h.emitted.map((m) => m.type)).toContain("compaction_card");
  });

  it("takes the compaction indicator down however the operation ended", async () => {
    // A compaction that announced itself and then failed left "Compacting…" up
    // across the user's whole turn.
    const h = makeHarness({ script: { kind: "errors", message: "boom" } });
    await applyPreTurnCompaction(h.args);
    const statuses = h.emitted.filter((m) => m.type === "compaction_status");
    expect(statuses.at(-1)).toMatchObject({ active: false });
  });

  it("spawns on the credential route selection chose", async () => {
    // docs/260 §1b — the route is threaded as a value and cannot be recovered
    // from the session row. Dropped, the spawn falls back to the service's
    // group credential, which can be an account routing had already set aside.
    const h = makeHarness({ turnRoute: { kind: "account", id: "route-B" } });
    await applyPreTurnCompaction(h.args);
    expect(h.routesSeen).toEqual([{ kind: "account", id: "route-B" }]);
  });
});

describe("applyPreTurnCompaction — what it reports", () => {
  it("reports success and says nothing extra when the backend compacted", async () => {
    const h = makeHarness({ script: { kind: "compacts" } });
    const result = await applyPreTurnCompaction(h.args);
    expect(result.outcome).toEqual({ kind: "compacted" });
    // The card is the record; a notice on top would be noise on the happy path.
    expect(result.afterUserMessagePersisted).toBeUndefined();
  });

  it("does NOT report success for a spawn that ended cleanly without compacting", async () => {
    // docs/276 req 2 — a trigger that exits 0 while doing nothing is not a
    // compaction, and must never be rendered as one.
    const h = makeHarness({ script: { kind: "silent" } });
    const result = await applyPreTurnCompaction(h.args);
    expect(result.outcome).toEqual({ kind: "no-compaction" });
    result.afterUserMessagePersisted!("s1");
    // Anchored in-band, not appended: `afterUserMessagePersisted` fires from
    // INSIDE the fresh turn, which is exactly when in-band recording is right.
    expect(JSON.stringify(h.emitted)).toContain("no compaction");
  });

  it("reports a failure, and the transcript says so (req 9)", async () => {
    const h = makeHarness({ script: { kind: "errors", message: "the CLI exited with code 1" } });
    const result = await applyPreTurnCompaction(h.args);
    expect(result.outcome.kind).toBe("failed");
    result.afterUserMessagePersisted!("s1");
    expect(JSON.stringify(h.emitted)).toContain("could not be compacted");
  });

  it("counts a compaction that happened even if the process then died", async () => {
    // The history really was replaced, so a failure notice for it would be
    // false — and the card is already in the transcript saying otherwise.
    const h = makeHarness({ script: { kind: "compacts-then-errors", message: "process exited" } });
    expect((await applyPreTurnCompaction(h.args)).outcome).toEqual({ kind: "compacted" });
  });

  it("bounds a stall inside credential prep, and still hands the session back", async () => {
    // `prepareAgentEnv` is an await the timer cannot interrupt. Sequenced ahead
    // of the settle latch it would park the user's message forever.
    const h = makeHarness({ envPrepHangs: true });
    vi.useFakeTimers();
    try {
      const pending = applyPreTurnCompaction(h.args);
      await vi.advanceTimersByTimeAsync(300_001);
      expect((await pending).outcome.kind).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
    expect(h.args.runner.preTurnHold).toBe(false);
    expect(h.slot.agent).toBeNull();
  });

  it("bounds a spawn that starts and then never settles", async () => {
    const h = makeHarness({ script: { kind: "hangs" } });
    vi.useFakeTimers();
    try {
      const pending = applyPreTurnCompaction(h.args);
      await vi.advanceTimersByTimeAsync(300_001);
      expect((await pending).outcome.kind).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
    // Left alive it would hold the slot the user's turn is about to take.
    expect(h.agents[0]!.killed).toBeGreaterThan(0);
    expect(h.slot.agent).toBeNull();
  });

  it("hands the merge probe's answer to the reset instead of making it probe again", async () => {
    // Both gates read the same merge state, and inside the poll window that
    // state changes. `applyPreTurnReset` takes `mergeRecheck ?? await probe()`,
    // so an answer handed over is an answer it does not go and re-derive.
    const h = makeHarness({ recheck: true });
    expect((await applyPreTurnCompaction(h.args)).mergeRecheck).toBe("unchanged");
  });

  it("still hands the answer over when it then decides not to compact", async () => {
    // The reset runs regardless of what the compaction decided, so the probe it
    // would otherwise pay for has to reach it on every path past the probe.
    const h = makeHarness({ recheck: true, session: makeSession({ mergedAt: undefined }) });
    const result = await applyPreTurnCompaction(h.args);
    expect(result.outcome).toEqual({ kind: "not-applicable" });
    expect(result.mergeRecheck).toBe("unchanged");
  });

  it("writes its notice exactly once across both delivery routes", async () => {
    const h = makeHarness({ script: { kind: "silent" } });
    const result = await applyPreTurnCompaction(h.args);
    result.afterUserMessagePersisted!("s1");
    const after = h.appended.length + h.emitted.length;
    // The `finally` fallback exists for a turn that died before the anchor. It
    // must not double the notice for one that reached it.
    result.ensureRecorded!("s1");
    expect(h.appended.length + h.emitted.length).toBe(after);
  });
});
