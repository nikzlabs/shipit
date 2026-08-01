import { beforeEach, describe, expect, it } from "vitest";
import { useGitStore } from "../../stores/git-store.js";
import { handleGitPushRejected } from "./git-push-rejected.js";
import type { HandlerContext } from "./types.js";

const ctx = {} as HandlerContext;
const message = {
  type: "git_push_rejected" as const,
  reason: "non_fast_forward" as const,
  message: "Push rejected",
};

beforeEach(() => {
  useGitStore.getState().reset();
});

describe("handleGitPushRejected", () => {
  it("shows the branch-behind nudge while idle", () => {
    handleGitPushRejected(ctx, message);

    expect(useGitStore.getState().pushRejected).toBe(true);
  });

  it("does not arm the branch-behind nudge during a rebase", () => {
    useGitStore.setState({ rebaseStatus: "in_progress" });

    handleGitPushRejected(ctx, message);

    expect(useGitStore.getState().pushRejected).toBe(false);
  });
});
