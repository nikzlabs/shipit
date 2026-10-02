import { describe, it, expect, beforeEach } from "vitest";
import type { PrStatusSummary } from "../../../server/shared/types.js";
import { usePrStore } from "../../stores/pr-store.js";
import { dispatchMessage } from "./index.js";
import type { HandlerContext } from "./types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

function status(overrides: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return {
    sessionId: "archived",
    prNumber: 7,
    prUrl: "https://github.com/o/r/pull/7",
    prTitle: "Old work",
    prBody: "Body",
    prState: "merged",
    baseBranch: "main",
    headBranch: "shipit/old",
    insertions: 1,
    deletions: 0,
    checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: "unknown",
    reviewDecision: "none",
    autoMergeEnabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  usePrStore.getState().reset();
});

describe("session_pr_status", () => {
  it("keeps the open session's PR through an SSE snapshot that covers only the sidebar", () => {
    dispatchMessage(ctx, { type: "session_pr_status", sessionId: "archived", status: status() });
    usePrStore.getState().applyPrStatusUpdates([], undefined, true, ["s1"]);

    expect(usePrStore.getState().statusBySession.archived?.prBody).toBe("Body");
    expect(usePrStore.getState().cardBySession.archived?.phase).toBe("merged");
  });

  // The two channels share no ordering: the attach-time read can land after a newer live update.
  it("does not overwrite a live update that arrived first", () => {
    usePrStore.getState().applyPrStatusUpdates([status({ prState: "merged" })]);
    dispatchMessage(ctx, {
      type: "session_pr_status",
      sessionId: "archived",
      status: status({ prState: "open" }),
    });

    expect(usePrStore.getState().statusBySession.archived?.prState).toBe("merged");
    expect(usePrStore.getState().cardBySession.archived?.phase).toBe("merged");
  });
});
