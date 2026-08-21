import { describe, it, expect, vi } from "vitest";

import { materializeRunnerSync, materializeRunner } from "./materialize-runner.js";
import type { MaterializeRunnerDeps } from "./materialize-runner.js";

/**
 * Unit coverage for the shared runner materialization (docs/131).
 *
 * This logic used to live inside `activateSession`'s per-connection closure and
 * now backs two transports (WS connect and HTTP dispatch). These pin the two
 * properties that make sharing safe: the guards can't be skipped by the new
 * caller, and the common path stays *synchronous* so the WS connect handler's
 * frame ordering is unchanged.
 */

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
    // The whole point of docs/131 req 8: a session nobody has open is still
    // reachable. Before this, only a WS connect ever called getOrCreate.
    const { deps, getOrCreate } = makeDeps({
      session: { workspaceDir: "/w/cold", agentId: "codex" },
    });
    const outcome = materializeRunnerSync(deps, "cold", "claude");
    expect(outcome.status).toBe("ready");
    // The session's own agent wins over the caller's fallback — a recovered
    // runner seeded with the global default must not spawn the wrong CLI.
    expect(getOrCreate).toHaveBeenCalledWith("cold", "/w/cold", "codex");
  });

  it("falls back to the caller's agent only when the session names none", () => {
    const { deps, getOrCreate } = makeDeps({ session: { workspaceDir: "/w/cold" } });
    materializeRunnerSync(deps, "cold", "claude");
    expect(getOrCreate).toHaveBeenCalledWith("cold", "/w/cold", "claude");
  });

  it("refuses to boot anything for an archived session", () => {
    // "Archived sessions receive nothing." Sharing this function is what stops
    // the HTTP path from quietly reintroducing a way around the invariant.
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
    // Regression guard: WS connect calls this WITHOUT awaiting and then sends
    // more frames, so a session that needs no restore must resolve with zero
    // yields. Making this async again reorders `session_container_freshness`
    // behind those frames (caught by connection.test.ts the first time).
    const { deps: noRemote } = makeDeps({ session: { workspaceDir: "/w" } });
    expect(materializeRunnerSync(noRemote, "s", "claude").status).toBe("ready");

    const { deps: withRemote, getOrCreate } = makeDeps({
      session: { workspaceDir: "/w", remoteUrl: "https://github.com/a/b" },
    });
    expect(materializeRunnerSync(withRemote, "s", "claude")).toEqual({
      status: "needs-restore", workspaceDir: "/w", agentId: "claude",
    });
    // No runner until the checkout is known to exist — booting a container
    // against a missing bind-mount source is the loop planning#181 fixed.
    expect(getOrCreate).not.toHaveBeenCalled();
  });
});

describe("materializeRunner", () => {
  it("surfaces an unrecoverable checkout as restore-failed", async () => {
    const { deps, getOrCreate } = makeDeps({
      session: { workspaceDir: "/w", remoteUrl: "https://github.com/a/b" },
    });
    // The bare cache is gone too — `restoreSessionWorkspace` throws.
    deps.createRepoGit = (() => { throw new Error("cache is gone"); }) as never;
    const outcome = await materializeRunner(deps, "s", "claude");
    expect(outcome).toMatchObject({ status: "restore-failed" });
    expect(getOrCreate).not.toHaveBeenCalled();
  });
});
