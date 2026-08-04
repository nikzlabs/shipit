import { beforeEach, describe, expect, it } from "vitest";
import { useGitStore } from "../../stores/git-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { handleRebaseConflicts } from "./rebase-conflicts.js";
import type { HandlerContext } from "./types.js";

const ctx = {} as HandlerContext;

beforeEach(() => {
  useGitStore.getState().reset();
  useSessionStore.setState({ sessionId: "s1" });
});

describe("handleRebaseConflicts", () => {
  it("keeps the rebase in progress while the agent resolves conflicts", () => {
    handleRebaseConflicts(ctx, {
      type: "rebase_conflicts",
      sessionId: "s1",
      conflicts: [{ path: "src/conflicted.ts" }],
    });

    expect(useGitStore.getState()).toMatchObject({
      rebaseStatus: "resolving",
      rebaseConflicts: [{ path: "src/conflicted.ts" }],
    });
  });

  it("ignores a message for another session", () => {
    // `useGitStore` is global; a replay racing a session switch would otherwise
    // paint the rebase surface of whichever session happens to be rendered.
    handleRebaseConflicts(ctx, {
      type: "rebase_conflicts",
      sessionId: "other-session",
      conflicts: [{ path: "src/conflicted.ts" }],
    });

    expect(useGitStore.getState()).toMatchObject({
      rebaseStatus: "idle",
      rebaseConflicts: [],
    });
  });
});
