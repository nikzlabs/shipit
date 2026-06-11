import { describe, it, expect, vi } from "vitest";
import { PermissionBroker, extractPermissionPath, describePermissionRequest } from "./permission-broker.js";
import type { AgentEvent } from "../shared/types.js";

function makeBroker(timeoutMs?: number) {
  const events: AgentEvent[] = [];
  const broker = new PermissionBroker({ broadcast: (e) => events.push(e), ...(timeoutMs ? { timeoutMs } : {}) });
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

    // Same path again → a fresh card surfaces (not auto-allowed).
    broker.request({ toolName: "Write", input: { file_path: ".npmrc" } });
    expect(broker.pendingCount).toBe(1);
  });

  it("auto-denies on timeout and marks the resolution expired", async () => {
    vi.useFakeTimers();
    try {
      const { broker, events } = makeBroker(1000);
      const pending = broker.request({ toolName: "Write", input: { file_path: ".env" } });
      vi.advanceTimersByTime(1000);
      await expect(pending).resolves.toMatchObject({ behavior: "deny" });
      expect(events.at(-1)).toMatchObject({ type: "agent_permission_resolved", behavior: "deny", expired: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejectAllPending denies + expires every in-flight request (teardown)", async () => {
    const { broker, events } = makeBroker();
    const a = broker.request({ toolName: "Write", input: { file_path: "a" } });
    const b = broker.request({ toolName: "Write", input: { file_path: "b" } });
    broker.rejectAllPending();
    await expect(a).resolves.toMatchObject({ behavior: "deny" });
    await expect(b).resolves.toMatchObject({ behavior: "deny" });
    expect(broker.pendingCount).toBe(0);
    const resolved = events.filter((e) => e.type === "agent_permission_resolved");
    expect(resolved).toHaveLength(2);
    expect(resolved.every((e) => e.type === "agent_permission_resolved" && e.expired)).toBe(true);
  });

  it("resolve() returns false for an unknown id (stale card)", () => {
    const { broker } = makeBroker();
    expect(broker.resolve("perm_missing", { behavior: "allow" })).toBe(false);
  });
});
