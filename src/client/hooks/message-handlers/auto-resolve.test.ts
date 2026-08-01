import { beforeEach, describe, expect, it } from "vitest";
import { useGitStore } from "../../stores/git-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { handleAutoResolveResult } from "./auto-resolve-result.js";
import { handleAutoResolveStarted } from "./auto-resolve-started.js";
import type { HandlerContext } from "./types.js";

const ctx = {} as HandlerContext;

beforeEach(() => {
  useGitStore.getState().reset();
  useSessionStore.setState({ sessionId: "s1" });
});

describe("automatic conflict resolution lifecycle", () => {
  it("shows rebase progress as soon as the automatic attempt starts", () => {
    useGitStore.setState({ pushRejected: true });
    handleAutoResolveStarted(ctx, {
      type: "auto_resolve_started",
      sessionId: "s1",
      baseBranch: "main",
      attempt: 1,
    });

    expect(useGitStore.getState()).toMatchObject({
      rebaseStatus: "in_progress",
      pushRejected: false,
    });
  });

  it("settles progress when the automatic attempt ends", () => {
    useGitStore.setState({ rebaseStatus: "in_progress" });
    handleAutoResolveResult(ctx, {
      type: "auto_resolve_result",
      sessionId: "s1",
      outcome: "deferred",
      attempt: 1,
    });

    expect(useGitStore.getState().rebaseStatus).toBe("idle");
  });

  it("ignores lifecycle events for another session", () => {
    handleAutoResolveStarted(ctx, {
      type: "auto_resolve_started",
      sessionId: "s2",
      baseBranch: "main",
      attempt: 1,
    });

    expect(useGitStore.getState().rebaseStatus).toBe("idle");
  });
});
