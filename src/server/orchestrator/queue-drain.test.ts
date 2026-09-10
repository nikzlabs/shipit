import { describe, it, expect, vi } from "vitest";
import { queuedMessageToDispatchOptions, releaseQueuedTurn, startQueuedMessage } from "./queue-drain.js";
import { toQueuedMessage } from "./session-runner.js";
import type { AgentDispatchOptions, QueuedMessage, SessionRunnerInterface } from "./session-runner.js";
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";

function fakeRunner(opts: { canRunDispatchedTurn?: boolean } = {}) {
  const ran: AgentDispatchOptions[] = [];
  const runner = {
    sessionId: "s1",
    canRunDispatchedTurn: opts.canRunDispatchedTurn ?? true,
    runDispatchedTurn: async (o: AgentDispatchOptions) => { ran.push(o); },
  } as unknown as SessionRunnerInterface;
  return { runner, ran };
}

describe("queue drain routing (planning#257)", () => {
  it("routes a dispatched entry back through runDispatchedTurn — never the interactive re-entry", async () => {
    const { runner, ran } = fakeRunner();
    const runInteractive = vi.fn(async () => {});
    const onTurnComplete = vi.fn();
    const next: QueuedMessage = {
      text: "child PR merged",
      execution: "dispatched",
      activity: "Resuming after child PR merged…",
      systemTurn: true,
      onTurnComplete,
      deliveryId: "watch-1:1",
    };

    await startQueuedMessage(runner, next, runInteractive);

    expect(runInteractive).not.toHaveBeenCalled();
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({
      text: "child PR merged",
      activity: "Resuming after child PR merged…",
      systemTurn: true,
      onTurnComplete,
    });
  });

  it("routes an interactive entry to the transport's own re-entry", async () => {
    const { runner, ran } = fakeRunner();
    const runInteractive = vi.fn(async () => {});
    const next: QueuedMessage = { text: "typed by the user", execution: "interactive" };

    await startQueuedMessage(runner, next, runInteractive);

    expect(runInteractive).toHaveBeenCalledWith(next);
    expect(ran).toEqual([]);
  });

  it("falls back to the interactive re-entry when the runner has no system-turn deps (rather than dropping the entry)", async () => {
    const { runner, ran } = fakeRunner({ canRunDispatchedTurn: false });
    const runInteractive = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await startQueuedMessage(runner, { text: "x", execution: "dispatched", systemTurn: true }, runInteractive);

    expect(runInteractive).toHaveBeenCalled();
    expect(ran).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("round-trips every per-turn field through enqueue → drain (a new field can't be silently narrowed)", () => {
    const onTurnComplete = vi.fn();
    const opts: Required<Omit<AgentDispatchOptions, "execution">> & { execution?: AgentDispatchOptions["execution"] } = {
      text: "everything",
      agentInterface: { source: "agent_interface_sdk", surface: "present" },
      messageOrigin: { sessionId: "parent", sessionTitle: "Parent", relation: "parent" },
      activity: "Working…",
      images: [{ data: "abc", mediaType: "image/png" }],
      files: [{ path: "src/a.ts" }],
      uploads: [{ path: "/uploads/a.png", type: "upload" }],
      permissionMode: "plan",
      resetMergedBranch: false,
      silent: false,
      compactContext: false,
      postTurn: "none",
      systemTurn: true,
      onTurnComplete,
      deliveryId: "watch-1:1",
      dictated: true,
    };

    const restored = queuedMessageToDispatchOptions(toQueuedMessage(testDispatch(opts)));

    for (const key of Object.keys(opts) as (keyof AgentDispatchOptions)[]) {
      expect(restored[key], `field "${key}" was dropped by the queue round-trip`).toEqual(opts[key]);
    }
    expect(restored.execution).toBe("dispatched");
  });
});

describe("releaseQueuedTurn (planning#338)", () => {
  function fakeReleaseRunner(opts: {
    running?: boolean;
    systemTurnInProgress?: boolean;
    mergeHold?: boolean;
    queueLength?: number;
  }) {
    const dispatched: AgentDispatchOptions[] = [];
    let dequeues = 0;
    const runner = {
      sessionId: "s1",
      running: opts.running ?? false,
      systemTurnInProgress: opts.systemTurnInProgress ?? false,
      mergeHold: opts.mergeHold ?? false,
      queueLength: opts.queueLength ?? 0,
      canRunDispatchedTurn: true,
      dequeue: () => {
        dequeues++;
        return toQueuedMessage(testDispatch({ text: "queued user msg", execution: "dispatched" }));
      },
      getQueueSnapshot: () => [],
      emitMessage: () => {},
      dispatch: (o: AgentDispatchOptions) => { dispatched.push(o); },
    } as unknown as SessionRunnerInterface;
    return { runner, dispatched, dequeueCount: () => dequeues };
  }

  it("refuses to release while a system flow holds the session between its own turns", () => {
    const { runner, dispatched, dequeueCount } = fakeReleaseRunner({
      running: false,
      systemTurnInProgress: true,
      queueLength: 1,
    });
    expect(releaseQueuedTurn(runner)).toBe(false);
    expect(dispatched).toEqual([]);
    expect(dequeueCount()).toBe(0);
  });

  it("refuses to release while ShipIt is merging this session's pull request", () => {
    const { runner, dispatched, dequeueCount } = fakeReleaseRunner({
      running: false,
      mergeHold: true,
      queueLength: 1,
    });
    expect(releaseQueuedTurn(runner)).toBe(false);
    expect(dispatched).toEqual([]);
    expect(dequeueCount()).toBe(0);
  });


  it("releases the head of the queue once the flow has released its hold", () => {
    const { runner, dispatched } = fakeReleaseRunner({
      running: false,
      systemTurnInProgress: false,
      queueLength: 1,
    });
    expect(releaseQueuedTurn(runner)).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.text).toBe("queued user msg");
  });
});
