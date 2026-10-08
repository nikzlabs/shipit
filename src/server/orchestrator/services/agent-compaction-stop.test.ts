// docs/324-agent-requested-compaction req 10 — what Stop ends.
import { describe, it, expect } from "vitest";
import type { QueuedMessage } from "../session-runner.js";
import type { PendingCompaction, SessionManager } from "../sessions.js";
import { stopCompactionContinuation, markCompactionContinuation } from "./agent-compaction-stop.js";

const SESSION = "compact-session";

function makeSessionManager(request: PendingCompaction) {
  const state = { request };
  const manager = {
    dropPendingCompactionNote: () => {
      state.request = state.request.instructions !== undefined ? { instructions: state.request.instructions } : {};
    },
  } as unknown as SessionManager;
  return { manager, state };
}

describe("stopCompactionContinuation", () => {
  it("drops the pending note and the queued continuation, keeps everything else, and never throws", () => {
    const { manager, state } = makeSessionManager({ instructions: "keep A", note: "start B" });
    const emitted: unknown[] = [];
    const ours = markCompactionContinuation({ text: "continue", execution: "dispatched" } as QueuedMessage);
    const theirs = { text: "user", execution: "dispatched" } as QueuedMessage;
    const fakeRunner = {
      sessionId: SESSION,
      messageQueue: [ours, theirs],
      emitMessage: (m: unknown) => { emitted.push(m); },
      getQueueSnapshot: () => [{ text: "user", position: 1 }],
    };
    stopCompactionContinuation(manager, fakeRunner);
    expect(state.request).toEqual({ instructions: "keep A" });
    expect(fakeRunner.messageQueue).toEqual([theirs]);
    expect(emitted).toHaveLength(1);

    const broken = { dropPendingCompactionNote: () => { throw new Error("db closed"); } };
    expect(() => stopCompactionContinuation(broken, { ...fakeRunner, messageQueue: [] })).not.toThrow();
  });
});
