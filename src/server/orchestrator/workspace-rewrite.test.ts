import { describe, it, expect, vi, afterEach } from "vitest";
import { onWorkspaceRewritten, type WorkspaceRewriteRunner } from "./workspace-rewrite.js";

afterEach(() => vi.restoreAllMocks());

describe("onWorkspaceRewritten", () => {
  it("re-reads the config and then re-checks dependencies", () => {
    const calls: string[] = [];
    const runner: WorkspaceRewriteRunner = {
      reevaluateWorkspaceConfig: () => { calls.push("config"); },
      notifyWorkspaceRewritten: () => { calls.push("deps"); },
    };

    onWorkspaceRewritten(runner, "test");

    expect(calls).toEqual(["config", "deps"]);
  });

  it("tells the dependency check WHICH rewrite moved the tree", () => {
    const deps = vi.fn();
    const runner: WorkspaceRewriteRunner = {
      reevaluateWorkspaceConfig: () => {},
      notifyWorkspaceRewritten: deps,
    };

    onWorkspaceRewritten(runner, "rollback");

    expect(deps).toHaveBeenCalledWith("rollback");
  });

  it("still re-checks dependencies when the config re-read throws", () => {
    const deps = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runner: WorkspaceRewriteRunner = {
      reevaluateWorkspaceConfig: () => { throw new Error("bad shipit.yaml"); },
      notifyWorkspaceRewritten: deps,
    };

    expect(() => onWorkspaceRewritten(runner, "test")).not.toThrow();
    expect(deps).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing dependency check", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runner: WorkspaceRewriteRunner = {
      reevaluateWorkspaceConfig: () => {},
      notifyWorkspaceRewritten: () => { throw new Error("boom"); },
    };

    expect(() => onWorkspaceRewritten(runner, "test")).not.toThrow();
  });

  it("no-ops on a session with no live runner, or a runner without the hooks", () => {
    expect(() => onWorkspaceRewritten(null, "test")).not.toThrow();
    expect(() => onWorkspaceRewritten(undefined, "test")).not.toThrow();
    expect(() => onWorkspaceRewritten({}, "test")).not.toThrow();
  });
});
