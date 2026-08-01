import { beforeEach, describe, expect, it } from "vitest";
import { useGitStore } from "../../stores/git-store.js";
import { handleRebaseConflicts } from "./rebase-conflicts.js";
import type { HandlerContext } from "./types.js";

const ctx = {} as HandlerContext;

beforeEach(() => {
  useGitStore.getState().reset();
});

describe("handleRebaseConflicts", () => {
  it("keeps the rebase in progress while the agent resolves conflicts", () => {
    handleRebaseConflicts(ctx, {
      type: "rebase_conflicts",
      conflicts: [{ path: "src/conflicted.ts" }],
    });

    expect(useGitStore.getState()).toMatchObject({
      rebaseStatus: "resolving",
      rebaseConflicts: [{ path: "src/conflicted.ts" }],
    });
  });
});
