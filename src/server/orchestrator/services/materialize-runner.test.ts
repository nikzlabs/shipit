import { describe, it, expect, vi } from "vitest";

import { materializeRunnerSync, materializeRunner } from "./materialize-runner.js";
import type { MaterializeRunnerDeps } from "./materialize-runner.js";

function makeDeps(overrides: {
  session?: Record<string, unknown> | undefined;
  existingRunner?: Record<string, unknown> | undefined;
} = {}) {
  const getOrCreate = vi.fn((sessionId: string, dir: string, agentId: string) => ({
    sessionId, sessionDir: dir, agentId, running: false, disposed: false,
  }));
  const setDiskTier = vi.fn();
  const deps = {
    sessionManager: {
      get: () => overrides.session,
      setDiskTier,
    },
    runnerRegistry: {
      get: () => overrides.existingRunner,
      getOrCreate,
    },
    createRepoGit: () => ({}),
    getBareCacheDir: () => "/cache",
    githubAuthManager: {},
    repoStore: {},
  } as unknown as MaterializeRunnerDeps;
  return { deps, getOrCreate, setDiskTier };
}

describe("materializeRunnerSync", () => {
  it("creates a runner for a session that has no runner", () => {
    const { deps, getOrCreate } = makeDeps({
      session: { workspaceDir: "/w/cold", agentId: "codex" },
    });
    const outcome = materializeRunnerSync(deps, "cold", "claude");
    expect(outcome.status).toBe("ready");
    expect(getOrCreate).toHaveBeenCalledWith("cold", "/w/cold", "codex");
  });

  it("falls back to the caller's agent only when the session names none", () => {
    const { deps, getOrCreate } = makeDeps({ session: { workspaceDir: "/w/cold" } });
    materializeRunnerSync(deps, "cold", "claude");
    expect(getOrCreate).toHaveBeenCalledWith("cold", "/w/cold", "claude");
  });

  it("refuses to boot anything for an archived session", () => {
    for (const flag of ["archived", "userArchived"]) {
      const { deps, getOrCreate } = makeDeps({
        session: { workspaceDir: "/w/old", [flag]: true },
      });
      expect(materializeRunnerSync(deps, "old", "claude")).toEqual({ status: "archived" });
      expect(getOrCreate).not.toHaveBeenCalled();
    }
  });

  it("reports no-workspace for an unknown session id", () => {
    const { deps, getOrCreate } = makeDeps({ session: undefined });
    expect(materializeRunnerSync(deps, "ghost", "claude")).toEqual({ status: "no-workspace" });
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("reuses an existing runner and reconciles its agent", () => {
    const existingRunner = { agentId: "claude", running: false, disposed: false };
    const { deps, getOrCreate } = makeDeps({
      session: { workspaceDir: "/w", agentId: "codex" },
      existingRunner,
    });
    const outcome = materializeRunnerSync(deps, "s", "claude");
    expect(outcome).toMatchObject({ status: "ready" });
    expect(existingRunner.agentId).toBe("codex");
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("never re-points a runner that is mid-turn", () => {
    const existingRunner = { agentId: "claude", running: true, disposed: false };
    const { deps } = makeDeps({
      session: { workspaceDir: "/w", agentId: "codex" },
      existingRunner,
    });
    materializeRunnerSync(deps, "s", "claude");
    expect(existingRunner.agentId).toBe("claude");
  });

  it("flips a `light` session back to hot without a restore round-trip", () => {
    const { deps, setDiskTier, getOrCreate } = makeDeps({
      session: { workspaceDir: "/w", diskTier: "light", remoteUrl: "https://x/y" },
    });
    const outcome = materializeRunnerSync(deps, "s", "claude");
    expect(setDiskTier).toHaveBeenCalledWith("s", "hot");
    expect(outcome.status).toBe("ready");
    expect(getOrCreate).toHaveBeenCalled();
  });

  it("defers only the case that needs the disk", () => {
    const { deps: noRemote } = makeDeps({ session: { workspaceDir: "/w" } });
    expect(materializeRunnerSync(noRemote, "s", "claude").status).toBe("ready");

    const { deps: withRemote, getOrCreate } = makeDeps({
      session: { workspaceDir: "/w", remoteUrl: "https://github.com/a/b" },
    });
    expect(materializeRunnerSync(withRemote, "s", "claude")).toEqual({
      status: "needs-restore", workspaceDir: "/w", agentId: "claude",
    });
    expect(getOrCreate).not.toHaveBeenCalled();
  });
});

describe("materializeRunner", () => {
  it("surfaces an unrecoverable checkout as restore-failed", async () => {
    const { deps, getOrCreate } = makeDeps({
      session: { workspaceDir: "/w", remoteUrl: "https://github.com/a/b" },
    });
    deps.createRepoGit = (() => { throw new Error("cache is gone"); }) as never;
    const outcome = await materializeRunner(deps, "s", "claude");
    expect(outcome).toMatchObject({ status: "restore-failed" });
    expect(getOrCreate).not.toHaveBeenCalled();
  });
});
