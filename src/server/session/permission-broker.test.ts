import { describe, it, expect, vi } from "vitest";
import { PermissionBroker, extractPermissionPath, describePermissionRequest } from "./permission-broker.js";
import type { AgentEvent } from "../shared/types.js";

function makeBroker() {
  const events: AgentEvent[] = [];
  const broker = new PermissionBroker({ broadcast: (e) => events.push(e) });
  return { broker, events };
}

describe("extractPermissionPath", () => {
  it("pulls file_path / notebook_path / path, else undefined", () => {
    expect(extractPermissionPath({ file_path: ".npmrc" })).toBe(".npmrc");
    expect(extractPermissionPath({ notebook_path: "x.ipynb" })).toBe("x.ipynb");
    expect(extractPermissionPath({ path: "y" })).toBe("y");
    expect(extractPermissionPath({ command: "ls" })).toBeUndefined();
    expect(extractPermissionPath(undefined)).toBeUndefined();
  });
});

describe("describePermissionRequest", () => {
  it("uses the path when present, else the command, else the tool name", () => {
    expect(describePermissionRequest("Write", ".npmrc", {})).toBe("Write .npmrc");
    expect(describePermissionRequest("Bash", undefined, { command: "rm -rf x\nmore" })).toBe("Bash: rm -rf x");
    expect(describePermissionRequest("Tool", undefined, undefined)).toBe("Tool");
  });
});

describe("PermissionBroker", () => {
  it("broadcasts a request event and resolves with the user's decision", async () => {
    const { broker, events } = makeBroker();
    const pending = broker.request({ toolName: "Write", input: { file_path: ".npmrc" }, agentId: "claude" });

    expect(events).toHaveLength(1);
    const req = events[0];
    expect(req.type).toBe("agent_permission_request");
    if (req.type !== "agent_permission_request") throw new Error("unreachable");
    expect(req.path).toBe(".npmrc");
    expect(req.toolName).toBe("Write");
    expect(broker.pendingCount).toBe(1);

    expect(broker.resolve(req.requestId, { behavior: "allow" })).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: "allow" });
    expect(broker.pendingCount).toBe(0);

    // A resolved event is broadcast for the orchestrator to patch the card.
    expect(events[1]).toMatchObject({ type: "agent_permission_resolved", behavior: "allow" });
  });

  it("never auto-resolves on a timer — a request stays pending until answered", async () => {
    vi.useFakeTimers();
    try {
      const { broker } = makeBroker();
      // The held promise is intentionally not awaited — `request` only settles
      // on a user decision, which we never make here.
      void broker.request({ toolName: "Write", input: { file_path: ".env" } });

      // Even after a very long wait, the request is still pending — a settled
      // request would have been removed from the broker's map. There is no timeout.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(broker.pendingCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-allows a remembered path without surfacing a new card", async () => {
    const { broker, events } = makeBroker();
    const first = broker.request({ toolName: "Write", input: { file_path: ".npmrc" } });
    const reqId = (events[0] as { requestId: string }).requestId;
    broker.resolve(reqId, { behavior: "allow", remember: true });
    await first;

    const eventCountAfterFirst = events.length;
    const second = await broker.request({ toolName: "Edit", input: { file_path: ".npmrc" } });
    expect(second).toEqual({ behavior: "allow" });
    // No new request/resolved events for the remembered path.
    expect(events).toHaveLength(eventCountAfterFirst);
  });

  it("does not remember a denied or non-remember decision", async () => {
    const { broker, events } = makeBroker();
    const first = broker.request({ toolName: "Write", input: { file_path: ".npmrc" } });
    broker.resolve((events[0] as { requestId: string }).requestId, { behavior: "allow" });
    await first;

    // Same path again → a fresh card surfaces (not auto-allowed). The request
    // intentionally stays pending (we only assert it was registered), so it's
    // `void`ed rather than awaited — awaiting would block until resolve/timeout.
    void broker.request({ toolName: "Write", input: { file_path: ".npmrc" } });
    expect(broker.pendingCount).toBe(1);
  });

  it("clearPending settles held promises on teardown WITHOUT broadcasting (card stays pending)", async () => {
    const { broker, events } = makeBroker();
    const a = broker.request({ toolName: "Write", input: { file_path: "a" } });
    const b = broker.request({ toolName: "Write", input: { file_path: "b" } });
    const eventsBefore = events.length;

    broker.clearPending();

    // Promises settle (so the worker doesn't leak a held bridge response)…
    await expect(a).resolves.toMatchObject({ behavior: "deny" });
    await expect(b).resolves.toMatchObject({ behavior: "deny" });
    expect(broker.pendingCount).toBe(0);
    // …but NO resolved event is broadcast — the card is left pending, never
    // flipped to a synthetic terminal/expired state.
    expect(events).toHaveLength(eventsBefore);
    expect(events.some((e) => e.type === "agent_permission_resolved")).toBe(false);
  });

  it("resolve() returns false for an unknown id (stale card)", () => {
    const { broker } = makeBroker();
    expect(broker.resolve("perm_missing", { behavior: "allow" })).toBe(false);
  });

  it("openRequest returns a requestId and poll holds until resolved (long-poll, Thread B)", async () => {
    const { broker, events } = makeBroker();
    const opened = broker.openRequest({ toolName: "Write", input: { file_path: ".npmrc" }, toolUseId: "tu" });
    expect(opened.requestId).toBeTruthy();
    expect(opened.immediate).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("agent_permission_request");

    const poll = broker.poll(opened.requestId!, 5000);
    // Resolve while the poll is held; it should return the decision and consume.
    expect(broker.resolve(opened.requestId!, { behavior: "allow" })).toBe(true);
    await expect(poll).resolves.toEqual({ settled: true, decision: { behavior: "allow" } });
    expect(broker.pendingCount).toBe(0);
  });

  it("poll returns { settled: false } when the bounded hold elapses (request stays pending)", async () => {
    const { broker } = makeBroker();
    const opened = broker.openRequest({ toolName: "Write", input: { file_path: ".env" }, toolUseId: "tu" });
    // A short hold elapses with no answer → poll again, request still pending.
    await expect(broker.poll(opened.requestId!, 5)).resolves.toEqual({ settled: false });
    expect(broker.pendingCount).toBe(1);
  });

  it("is idempotent on toolUseId — a duplicate open re-attaches to one card", () => {
    const { broker, events } = makeBroker();
    const a = broker.openRequest({ toolName: "Write", input: { file_path: ".npmrc" }, toolUseId: "dup" });
    const b = broker.openRequest({ toolName: "Write", input: { file_path: ".npmrc" }, toolUseId: "dup" });
    expect(b.requestId).toBe(a.requestId);
    // Only ONE card broadcast despite two opens (no stacking).
    expect(events).toHaveLength(1);
    expect(broker.pendingCount).toBe(1);
  });

  it("a distinct toolUseId opens its own card (real model retries aren't merged)", () => {
    const { broker, events } = makeBroker();
    broker.openRequest({ toolName: "Write", input: { file_path: ".npmrc" }, toolUseId: "one" });
    broker.openRequest({ toolName: "Write", input: { file_path: ".npmrc" }, toolUseId: "two" });
    expect(events).toHaveLength(2);
    expect(broker.pendingCount).toBe(2);
  });

  it("poll on an unknown id fails closed so the bridge stops looping", async () => {
    const { broker } = makeBroker();
    await expect(broker.poll("perm_missing", 5000)).resolves.toEqual({
      settled: true,
      decision: { behavior: "deny" },
    });
  });

  it("a poll arriving just after resolution still gets the decision", async () => {
    const { broker } = makeBroker();
    const opened = broker.openRequest({ toolName: "Write", input: { file_path: ".npmrc" }, toolUseId: "tu" });
    broker.resolve(opened.requestId!, { behavior: "deny", message: "nope" });
    // The entry is retained (settled) until a consumer reads it.
    await expect(broker.poll(opened.requestId!, 5000)).resolves.toEqual({
      settled: true,
      decision: { behavior: "deny", message: "nope" },
    });
    expect(broker.pendingCount).toBe(0);
  });

  it("auto-allows ShipIt-handled interrupt tools without surfacing a card", async () => {
    // AskUserQuestion / ExitPlanMode are handled by ShipIt's own interrupt flow
    // (question card / PlanApproval card). The Claude CLI still routes them
    // through --permission-prompt-tool (docs/193); the broker must auto-allow so
    // a dead-end permission card never appears instead of the real card.
    for (const toolName of ["AskUserQuestion", "ExitPlanMode"]) {
      const { broker, events } = makeBroker();
      const decision = await broker.request({ toolName, input: {} });
      expect(decision).toEqual({ behavior: "allow" });
      // No request/resolved events: nothing was surfaced or persisted.
      expect(events).toHaveLength(0);
      expect(broker.pendingCount).toBe(0);
    }
  });
});
