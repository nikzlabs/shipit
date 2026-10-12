import { describe, it, expect, vi } from "vitest";
import { sendChildMessage, deliverSessionMessage } from "./child-sessions.js";
import { ServiceError } from "./types.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo } from "../../shared/types.js";
import type { InboxTold, SessionInbox } from "./session-inbox.js";

/**
 * docs/314 req 7 — the delivery body is shared with the proposal card's route,
 * so this pins the thing that must NOT have travelled with it:
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
const ORIGIN = { sessionId: "reporter-1", sessionTitle: "Reporter", relation: "proposed" as const };

function stubSessionManager(sessions: SessionInfo[]): SessionManager {
  return {
    get: (id: string) => sessions.find((s) => s.id === id),
    findChildren: () => [],
  } as unknown as SessionManager;
}

function stubDeps(told: InboxTold = "started") {
  const post = vi.fn<SessionInbox["post"]>(async () => ({ told }));
  const append = vi.fn();
  return {
    post,
    append,
    deps: {
      sessionInbox: { post },
      runnerRegistry: { get: () => undefined } as unknown as SessionRunnerRegistry,
      chatHistoryManager: { append, replaceInProgress: vi.fn() },
    },
  };
}

describe("sendChildMessage reach, after the docs/314 extraction", () => {
  it.each([
    ["a root session", ROOT],
    ["a sibling", SIBLING],
    ["a grandchild", GRANDCHILD],
  ])("still refuses %s", async (_label, target) => {
    const { deps, post, append } = stubDeps();
    await expect(sendChildMessage(
      { ...deps, sessionManager: stubSessionManager([target]) },
      "parent-1",
      target.id,
      "report back",
    )).rejects.toMatchObject({ statusCode: 404 });
    expect(post).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});

describe("deliverSessionMessage", () => {
  it("stores the message in the inbox of a session with no link to the caller, carrying the origin", async () => {
    const { deps, post } = stubDeps();
    const result = await deliverSessionMessage(deps, ROOT, "PR is open.", ORIGIN);

    expect(result).toEqual({ queuePosition: 0, enqueued: false, told: "started" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(ROOT, { origin: ORIGIN, body: "PR is open." });
  });

  // docs/314-session-message-proposal req 6 — the user of the receiving session sees the
  // message and its sender in the transcript, whenever the agent reads its inbox.
  it("puts a card with the message and the sender's name in the recipient's transcript", async () => {
    const { deps, append } = stubDeps("later");
    await deliverSessionMessage(deps, ROOT, "PR is open.", ORIGIN);

    expect(append).toHaveBeenCalledTimes(1);
    const [recipient, row] = append.mock.calls[0]!;
    expect(recipient).toBe("root-1");
    // No text: a row with text is replayed to an agent as part of its own conversation.
    expect(row).toMatchObject({ role: "assistant", text: "" });
    expect(row.sessionReport).toMatchObject({
      fromSessionId: "reporter-1",
      fromTitle: "Reporter",
      relation: "proposed",
      body: "PR is open.",
    });
    expect(row.sessionReport).not.toHaveProperty("severity");
  });

  /**
   * A steered notice reaches a running target at once. Reporting it as waiting
   * puts "its agent is told when it is free" on a card whose notice has arrived.
   */
  it.each([
    ["steered", false],
    ["started", false],
    ["later", true],
    ["failed", true],
  ] as const)("reports a recipient that was told %s as waiting=%s", async (told, waiting) => {
    const result = await deliverSessionMessage(stubDeps(told).deps, ROOT, "PR is open.", ORIGIN);
    expect(result.told).toBe(told);
    expect(result.enqueued).toBe(waiting);
  });

  it("refuses a target with no workspace rather than storing a message for it", async () => {
    const { deps, post, append } = stubDeps();
    await expect(deliverSessionMessage(
      deps,
      { ...ROOT, workspaceDir: undefined } as unknown as SessionInfo,
      "hi",
      ORIGIN,
    )).rejects.toBeInstanceOf(ServiceError);
    expect(post).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});
