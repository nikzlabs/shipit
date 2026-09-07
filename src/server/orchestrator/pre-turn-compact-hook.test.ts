/**
 * docs/295 — the shared per-turn wiring of the merged-session context compaction.
 *
 * The gate is `services/pre-turn-reset.test.ts`'s subject (this hook asks the
 * same `isResetEligible` on purpose, so re-testing the nine clauses here would
 * only duplicate them). What is tested here is everything docs/295's own
 * requirements add on top:
 *
 *  - WHEN it runs at all — the setting, the per-send untick, the harness
 *    capability, and eligibility (reqs 5, 10, 11, and 1/3 by proxy);
 *  - WHAT it runs — a turn in the one mode that makes a pre-turn spawn safe
 *    (`postTurn: "none"` + `systemTurn: true`), carrying no user row and no
 *    echo;
 *  - WHAT it reports — an outcome, never bare completion, so a backend that
 *    accepts the trigger and does nothing cannot be rendered as a success
 *    (req 9, and docs/276 req 2, which is the precedent).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent, AgentProcess, SessionInfo, WsServerMessage } from "../shared/types.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { GitManager } from "../shared/git.js";
import type { PersistedMessage } from "./chat-history.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";
import type { TurnInput } from "./turn-executor.js";
import { TURN_COMPLETED, turnErrored } from "./turn-settlement.js";

/**
 * The compaction is a real turn, so the executor is the seam. Mocking it keeps
 * these tests about the hook's decisions rather than about spawning a CLI —
 * and lets each case control the one thing the hook cannot see for itself:
 * whether an `agent_compacted` event arrived.
 */
const executeAgentTurn = vi.fn<(
  runner: SessionRunnerInterface | null,
  deps: SystemTurnDeps,
  agent: AgentProcess,
  input: TurnInput,
) => Promise<void>>();
vi.mock("./turn-executor.js", () => ({
  executeAgentTurn: (...args: unknown[]) =>
    (executeAgentTurn as unknown as (...a: unknown[]) => Promise<void>)(...args),
}));

const supportsCompaction = vi.fn<() => boolean>(() => true);
vi.mock("../shared/agent-registry.js", () => ({
  getAgentCapabilities: () => ({ supportsCompaction: supportsCompaction() }),
}));

const { applyPreTurnCompaction } = await import("./pre-turn-compact-hook.js");

const MERGED_SHA = "a1f3c9d0000000000000000000000000000000aa";
const BASE_TIP = "7e02b480000000000000000000000000000000bb";

beforeEach(() => {
  executeAgentTurn.mockReset();
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
    prTitle: "Fix login redirect",
    prBody: "",
    prState: "merged",
    baseBranch: "main",
    headBranch: "shipit/fix-login",
    insertions: 1,
    deletions: 0,
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "unknown",
    reviewDecision: "none",
    autoMergeEnabled: false,
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

interface Harness {
  args: Parameters<typeof applyPreTurnCompaction>[0];
  emitted: WsServerMessage[];
  appended: PersistedMessage[];
  slot: { agent: AgentProcess | null };
  superseded: string[];
  killed: string[];
}

/**
 * A stand-in for the compaction spawn. `fire` is how a test replays what a real
 * adapter puts on the `event` channel — the hook's only way of learning that a
 * compaction actually happened.
 */
interface FakeAgent extends AgentProcess {
  fire(event: AgentEvent): void;
}

function makeAgent(): FakeAgent {
  const listeners: ((e: AgentEvent) => void)[] = [];
  return {
    agentId: "claude",
    on(event: string, handler: (...a: never[]) => void) {
      if (event === "event") listeners.push(handler as unknown as (e: AgentEvent) => void);
      return this;
    },
    emit: vi.fn(),
    kill: vi.fn(),
    fire: (event: AgentEvent) => { for (const l of listeners) l(event); },
  } as unknown as FakeAgent;
}

function makeHarness(over: {
  session?: SessionInfo | undefined;
  git?: GitManager;
  setting?: boolean;
  intent?: boolean;
  resident?: boolean;
} = {}): Harness {
  const emitted: WsServerMessage[] = [];
  const appended: PersistedMessage[] = [];
  const superseded: string[] = [];
  const killed: string[] = [];
  const session = "session" in over ? over.session : makeSession();

  const residentAgent = over.resident
    ? ({
        agentId: "claude",
        on: vi.fn(),
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
    running: false,
    chatMessageGroups: [],
    recordedCards: [],
    steeredMessages: [],
    getTurnEventBuffer: () => [],
    lastPersistedBufferIndex: 0,
  } as unknown as SessionRunnerInterface;

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
    } as unknown as Parameters<typeof applyPreTurnCompaction>[0]["deps"],
    turnDeps: {} as unknown as SystemTurnDeps,
    runner,
    agentId: "claude",
    sessionId: "s1",
    sessionDir: "/w/s1",
    createAgent: () => makeAgent(),
    ...(over.intent !== undefined ? { intent: over.intent } : {}),
  };

  return { args, emitted, appended, slot, superseded, killed };
}

/** The executor stand-in: settles the turn, optionally emitting a compaction. */
function executorThat(opts: { compacted: boolean; outcome?: ReturnType<typeof turnErrored> }): void {
  executeAgentTurn.mockImplementation(async (_runner, _deps, agent, input) => {
    // Replayed through the same `on("event")` channel the hook subscribed with,
    // so a hook that stopped listening — or listened for the wrong event — fails
    // here rather than silently reporting `no-compaction` forever.
    if (opts.compacted) (agent as FakeAgent).fire({ type: "agent_compacted" } as AgentEvent);
    input.onTurnComplete?.(opts.outcome ?? TURN_COMPLETED);
  });
}

describe("applyPreTurnCompaction — when it runs at all", () => {
  it("does nothing when the shared setting is off (req 11)", async () => {
    const h = makeHarness({ setting: false });
    const result = await applyPreTurnCompaction(h.args);
    expect(result.outcome).toEqual({ kind: "not-applicable" });
    expect(executeAgentTurn).not.toHaveBeenCalled();
  });

  it("does nothing when the user unticked the control for this message (req 5)", async () => {
    const h = makeHarness({ intent: false });
    const result = await applyPreTurnCompaction(h.args);
    expect(result.outcome).toEqual({ kind: "not-applicable" });
    expect(executeAgentTurn).not.toHaveBeenCalled();
  });

  it("does nothing when the backend cannot compact (req 10)", async () => {
    supportsCompaction.mockReturnValue(false);
    const h = makeHarness();
    const result = await applyPreTurnCompaction(h.args);
    expect(result.outcome).toEqual({ kind: "not-applicable" });
    expect(executeAgentTurn).not.toHaveBeenCalled();
  });

  it("does nothing on a session that is not reset-eligible (reqs 1 and 3)", async () => {
    // Not merged: the ordinary state of nearly every session, and the state in
    // which the composer offers neither control.
    const h = makeHarness({ session: makeSession({ mergedAt: undefined }) });
    const result = await applyPreTurnCompaction(h.args);
    expect(result.outcome).toEqual({ kind: "not-applicable" });
    expect(executeAgentTurn).not.toHaveBeenCalled();
  });

  it("does nothing when the branch has moved past the merge, so a reset would be refused", async () => {
    const h = makeHarness({
      git: makeGit({ getHeadHash: vi.fn().mockResolvedValue("cafe0000000000000000000000000000000000ff") }),
    });
    const result = await applyPreTurnCompaction(h.args);
    expect(result.outcome).toEqual({ kind: "not-applicable" });
    expect(executeAgentTurn).not.toHaveBeenCalled();
  });

  it("runs with no per-send intent at all — the programmatic path (req 13)", async () => {
    executorThat({ compacted: true });
    const h = makeHarness(); // no `intent` key: a dispatch carries no tick box
    await applyPreTurnCompaction(h.args);
    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
  });

  it("runs when the reset was unticked but the compaction was not (req 6)", async () => {
    // The two controls are independent, and this is the case that proves it:
    // the hook is never told what the reset intent was.
    executorThat({ compacted: true });
    const h = makeHarness({ intent: true });
    await applyPreTurnCompaction(h.args);
    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
  });
});

describe("applyPreTurnCompaction — what it runs", () => {
  it("runs a turn that cannot commit, push, or drain the queue", async () => {
    executorThat({ compacted: true });
    const h = makeHarness();
    await applyPreTurnCompaction(h.args);

    const input = executeAgentTurn.mock.calls[0]![3];
    // `postTurn: "none"` is what elides the auto-commit, the PR flow AND the
    // queue drain. Without it the compaction would commit the user's un-run
    // turn and start a queued message on top of the turn about to spawn.
    expect(input.postTurn).toBe("none");
    // `systemTurn` holds `systemTurnInProgress`, so a message arriving during
    // the compaction is queued rather than steered into it.
    expect(input.systemTurn).toBe(true);
    // Without this the adapter runs `/compact …` as an ordinary prompt.
    expect(input.compact).toBe(true);
  });

  it("does not fake a user message", async () => {
    executorThat({ compacted: true });
    const h = makeHarness();
    await applyPreTurnCompaction(h.args);

    const input = executeAgentTurn.mock.calls[0]![3];
    // ShipIt started this, not the user. An echo or a persisted row would put a
    // `/compact` bubble the user never typed into the transcript.
    expect(input.emitUserEcho).toBe(false);
    const before = h.appended.length;
    input.persistUserMessage("s1");
    expect(h.appended.length).toBe(before);
  });

  it("carries the post-merge instructions in the prompt", async () => {
    executorThat({ compacted: true });
    const h = makeHarness();
    await applyPreTurnCompaction(h.args);

    const input = executeAgentTurn.mock.calls[0]![3];
    expect(input.prompt.startsWith("/compact ")).toBe(true);
    expect(input.prompt).toContain("merged");
  });

  it("retires and settles a resident process before spawning, then hands the slot back empty", async () => {
    executorThat({ compacted: true });
    const h = makeHarness({ resident: true });
    await applyPreTurnCompaction(h.args);

    // planning#318 — settling first is what stops the retired turn looking like a
    // delivery that never happened, which a supervisor would re-deliver.
    expect(h.superseded).toEqual(["resident:superseded"]);
    expect(h.killed).toEqual(["resident"]);
    // The user's turn resolves its own agent immediately after this returns; a
    // spent compaction proxy left installed would own the SSE routing its
    // events depend on.
    expect(h.slot.agent).toBeNull();
  });
});

describe("applyPreTurnCompaction — what it reports", () => {
  it("reports success and says nothing extra when the backend compacted", async () => {
    executorThat({ compacted: true });
    const h = makeHarness();
    const result = await applyPreTurnCompaction(h.args);

    expect(result.outcome).toEqual({ kind: "compacted" });
    // The compaction card (docs/178) is the record; a notice on top would be
    // noise on the happy path.
    expect(result.afterUserMessagePersisted).toBeUndefined();
    expect(result.ensureRecorded).toBeUndefined();
  });

  it("does NOT report success for a turn that ended cleanly without compacting", async () => {
    // docs/276 req 2 — a trigger that exits 0 while doing nothing is not a
    // compaction. This is the guard against reporting one as if it were.
    executorThat({ compacted: false });
    const h = makeHarness();
    const result = await applyPreTurnCompaction(h.args);

    expect(result.outcome).toEqual({ kind: "no-compaction" });
    result.afterUserMessagePersisted!("s1");
    expect(h.appended.length + h.emitted.length).toBeGreaterThan(0);
  });

  it("reports a failure, and the transcript says so (req 9)", async () => {
    executorThat({ compacted: false, outcome: turnErrored("the CLI exited with code 1") });
    const h = makeHarness();
    const result = await applyPreTurnCompaction(h.args);

    expect(result.outcome.kind).toBe("failed");
    result.afterUserMessagePersisted!("s1");
    const text = [...h.appended.map((m) => m.text), JSON.stringify(h.emitted)].join(" ");
    expect(text).toContain("could not be compacted");
  });

  it("counts a compaction that happened even if the process then died (outcome over exit code)", async () => {
    // The history really was replaced, so calling it a failure would put a
    // false notice in the transcript.
    executorThat({ compacted: true, outcome: turnErrored("process exited") });
    const h = makeHarness();
    const result = await applyPreTurnCompaction(h.args);
    expect(result.outcome).toEqual({ kind: "compacted" });
  });

  it("writes its notice exactly once across both delivery routes", async () => {
    executorThat({ compacted: false });
    const h = makeHarness();
    const result = await applyPreTurnCompaction(h.args);

    result.afterUserMessagePersisted!("s1");
    const after = h.appended.length + h.emitted.length;
    // The `finally` fallback exists for a turn that died before the anchor. It
    // must not double the notice for one that reached it.
    result.ensureRecorded!("s1");
    expect(h.appended.length + h.emitted.length).toBe(after);
  });
});
