import { describe, it, expect, vi } from "vitest";
import { sendChildMessage, deliverSessionMessage } from "./child-sessions.js";
import { ServiceError } from "./types.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { AgentId, SessionInfo } from "../../shared/types.js";
import { TURN_COMPLETED, type TurnAdmission } from "../turn-settlement.js";

/**
 * docs/314 req 7 — the delivery body is now shared with the proposal card's
 * route, so this pins the thing that must NOT have travelled with it:
 * `sendChildMessage` still admits a direct child and nothing else.
 */

const ROOT: SessionInfo = {
  id: "root-1",
  title: "Orchestrator",
  workspaceDir: "/tmp/root-1",
  archived: false,
  lastUsedAt: "2026-09-22T10:00:00.000Z",
} as unknown as SessionInfo;

const SIBLING: SessionInfo = { ...ROOT, id: "sibling-1", parentSessionId: "other-parent" };
const GRANDCHILD: SessionInfo = { ...ROOT, id: "gc-1", parentSessionId: "child-1" };

function stubSessionManager(sessions: SessionInfo[]): SessionManager {
  return {
    get: (id: string) => sessions.find((s) => s.id === id),
    findChildren: () => [],
  } as unknown as SessionManager;
}

function stubRegistry(agentId: AgentId = "claude", admitted: TurnAdmission = "started") {
  // The caller reads the handle's admission; a bare vi.fn() would hide it.
  const runner = {
    agentId,
    running: false,
    disposed: false,
    dispatch: vi.fn((_opts: unknown) => (
      { admitted, settled: Promise.resolve(TURN_COMPLETED) }
    )),
  };
  return {
    runner,
    registry: {
      getOrCreate: vi.fn(() => runner),
      get: vi.fn(() => runner),
      dispose: vi.fn(),
    } as unknown as SessionRunnerRegistry,
  };
}

describe("sendChildMessage reach, after the docs/314 extraction", () => {
  it.each([
    ["a root session", ROOT],
    ["a sibling", SIBLING],
    ["a grandchild", GRANDCHILD],
  ])("still refuses %s", async (_label, target) => {
    const { registry, runner } = stubRegistry();
    await expect(sendChildMessage(
      stubSessionManager([target]),
      registry,
      "parent-1",
      target.id,
      "report back",
      "claude",
      undefined,
      undefined,
    )).rejects.toMatchObject({ statusCode: 404 });
    expect(runner.dispatch).not.toHaveBeenCalled();
  });
});

describe("deliverSessionMessage", () => {
  it("dispatches into a session with no link to the caller, carrying the origin", async () => {
    const { registry, runner } = stubRegistry();
    const result = await deliverSessionMessage(
      stubSessionManager([ROOT]),
      registry,
      ROOT,
      "PR is open.",
      { sessionId: "reporter-1", sessionTitle: "Reporter", relation: "proposed" },
      "claude",
      undefined,
      undefined,
    );

    expect(result).toMatchObject({ queuePosition: 0, admitted: "started" });
    expect(runner.dispatch).toHaveBeenCalledTimes(1);
    expect(runner.dispatch.mock.calls[0][0]).toMatchObject({
      text: "PR is open.",
      messageOrigin: { sessionId: "reporter-1", relation: "proposed" },
    });
  });

  /**
   * A STEERED message reaches a running target immediately. Reporting it as
   * queued — which reading `runner.running` would do — puts "Queued behind…" on
   * a card whose message has already arrived.
   */
  it("reports a steered dispatch as steered, not queued", async () => {
    const { registry } = stubRegistry("claude", "steered");
    const result = await deliverSessionMessage(
      stubSessionManager([ROOT]),
      registry,
      ROOT,
      "PR is open.",
      { sessionId: "reporter-1", sessionTitle: "Reporter", relation: "proposed" },
      "claude",
      undefined,
      undefined,
    );
    expect(result.admitted).toBe("steered");
    expect(result.queuePosition).toBe(0);
  });

  it("refuses a target with no workspace rather than creating a runner for it", async () => {
    const { registry, runner } = stubRegistry();
    await expect(deliverSessionMessage(
      stubSessionManager([]),
      registry,
      { ...ROOT, workspaceDir: undefined } as unknown as SessionInfo,
      "hi",
      { sessionId: "reporter-1", sessionTitle: "Reporter", relation: "proposed" },
      "claude",
      undefined,
      undefined,
    )).rejects.toBeInstanceOf(ServiceError);
    expect(runner.dispatch).not.toHaveBeenCalled();
  });
});
