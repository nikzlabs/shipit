import { describe, it, expect, vi } from "vitest";
import { queuedMessageToDispatchOptions, startQueuedMessage } from "./queue-drain.js";
import { toQueuedMessage } from "./session-runner.js";
import type { AgentDispatchOptions, QueuedMessage, SessionRunnerInterface } from "./session-runner.js";
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";

/** Minimal runner surface `startQueuedMessage` touches. */
function fakeRunner(opts: { canRunDispatchedTurn?: boolean } = {}) {
  const ran: AgentDispatchOptions[] = [];
  const runner = {
    sessionId: "s1",
    canRunDispatchedTurn: opts.canRunDispatchedTurn ?? true,
    runDispatchedTurn: async (o: AgentDispatchOptions) => { ran.push(o); },
  } as unknown as SessionRunnerInterface;
  return { runner, ran };
}

describe("queue drain routing (SHI-255)", () => {
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
    // The whole option set survives — these two are what the WS drain dropped.
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
      activity: "Working…",
      images: [{ data: "abc", mediaType: "image/png" }],
      files: [{ path: "src/a.ts" }],
      uploads: [{ path: "/uploads/a.png", type: "upload" }],
      permissionMode: "plan",
      postTurn: "none",
      systemTurn: true,
      onTurnComplete,
      deliveryId: "watch-1:1",
    };

    // docs/240 — `toQueuedMessage` now takes a branded `PreparedDispatch` (so
    // the queue can't be entered around the brand either); `testDispatch` is the
    // test-only shim that mints one from a partial literal. The property under
    // test is unchanged: nothing may be lost on the way in or out.
    const restored = queuedMessageToDispatchOptions(toQueuedMessage(testDispatch(opts)));

    // Every key the caller set is still set after the queue round-trip. This is
    // the guard: adding a field to AgentDispatchOptions without teaching
    // `toQueuedMessage` / `queuedMessageToDispatchOptions` about it fails here.
    for (const key of Object.keys(opts) as (keyof AgentDispatchOptions)[]) {
      expect(restored[key], `field "${key}" was dropped by the queue round-trip`).toEqual(opts[key]);
    }
    expect(restored.execution).toBe("dispatched");
  });
});
