/**
 * nikzlabs/shipit#2429 — `onWorkspaceRewritten` is the one call every
 * orchestrator-side tree rewrite makes, so what it guarantees is: both halves
 * fire, in the order that lets the second read the first's result, and neither
 * can throw at a caller whose real work has already landed.
 */
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

    // Order is load-bearing: the config re-read is what applies an incoming
    // `shipit.yaml`'s `agent.install` / `install-inputs` to the runner, and the
    // dependency check must evaluate the incoming config, not the outgoing one.
    expect(calls).toEqual(["config", "deps"]);
  });

  it("still re-checks dependencies when the config re-read throws", () => {
    const deps = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runner: WorkspaceRewriteRunner = {
      reevaluateWorkspaceConfig: () => { throw new Error("bad shipit.yaml"); },
      notifyWorkspaceRewritten: deps,
    };

    // The whole point of the shared helper: one half failing must not silently
    // take the other with it, which is how the dependency check would inherit
    // the config path's failure modes.
    expect(() => onWorkspaceRewritten(runner, "test")).not.toThrow();
    expect(deps).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing dependency check", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runner: WorkspaceRewriteRunner = {
      reevaluateWorkspaceConfig: () => {},
      notifyWorkspaceRewritten: () => { throw new Error("boom"); },
    };

    // The caller's rebase/reset already landed and was already reported; this
    // must never turn it into a failure.
    expect(() => onWorkspaceRewritten(runner, "test")).not.toThrow();
  });

  it("no-ops on a session with no live runner, or a runner without the hooks", () => {
    expect(() => onWorkspaceRewritten(null, "test")).not.toThrow();
    expect(() => onWorkspaceRewritten(undefined, "test")).not.toThrow();
    // Both members are optional on `SessionRunnerInterface` (container runners
    // only), so a local-mode runner reaching here is expected, not a bug.
    expect(() => onWorkspaceRewritten({}, "test")).not.toThrow();
  });
});
