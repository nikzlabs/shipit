/**
 * docs/298-broken-workspace-visibility — the open-time half of the marker: the disk
 * janitor only ever looks at a session idle enough to evict, so a session the user
 * has open was the one case nothing evaluated.
 */
import { describe, it, expect, vi } from "vitest";
import type { GitManager } from "../../shared/git.js";
import type { SessionInfo, WorkspaceBlockKind } from "../../shared/types.js";
import { refreshWorkspaceBlockOnActivation } from "./workspace-block.js";

function makeSessionManager(session: Partial<SessionInfo> & { id: string }) {
  const state = { ...session } as SessionInfo;
  return {
    state,
    get: (id: string) => (id === state.id ? state : undefined),
    setWorkspaceBlock: (id: string, kind: WorkspaceBlockKind | null): boolean => {
      if (id !== state.id) return false;
      const next = kind ?? undefined;
      if (state.workspaceBlock === next) return false;
      state.workspaceBlock = next;
      return true;
    },
  };
}

function makeGit(tree: {
  clean?: boolean;
  conflictedFiles?: string[];
  unreadable?: { kind: "omitted" | "blocked"; detail: string } | null;
  rebaseInProgress?: boolean;
  sequencerInProgress?: boolean;
}): GitManager {
  return {
    inspectWorkingTree: () => Promise.resolve({
      clean: tree.clean ?? true,
      conflictedFiles: tree.conflictedFiles ?? [],
      unreadable: tree.unreadable ?? null,
    }),
    isRebaseInProgress: () => Promise.resolve(tree.rebaseInProgress ?? false),
    isMergeOrSequencerInProgress: () => Promise.resolve(tree.sequencerInProgress ?? false),
  } as unknown as GitManager;
}

const cleanGit = () => makeGit({});

describe("refreshWorkspaceBlockOnActivation", () => {
  it("marks a broken checkout and re-broadcasts the session list", async () => {
    const sessionManager = makeSessionManager({ id: "s1" });
    const onSessionsChanged = vi.fn();

    await refreshWorkspaceBlockOnActivation(
      { sessionManager, createGitManager: () => makeGit({ rebaseInProgress: true }), onSessionsChanged },
      "s1",
      "/ws",
    );

    expect(sessionManager.state.workspaceBlock).toBe("conflict");
    expect(onSessionsChanged).toHaveBeenCalledTimes(1);
  });

  it("withdraws a conflict marker once the tree is repaired, and re-broadcasts", async () => {
    const sessionManager = makeSessionManager({ id: "s1", workspaceBlock: "conflict" });
    const onSessionsChanged = vi.fn();

    await refreshWorkspaceBlockOnActivation(
      { sessionManager, createGitManager: cleanGit, onSessionsChanged },
      "s1",
      "/ws",
    );

    expect(sessionManager.state.workspaceBlock).toBeUndefined();
    expect(onSessionsChanged).toHaveBeenCalledTimes(1);
  });

  /**
   * A `secret` block needs `autoCommit`'s scan to see, and this check never commits.
   * Clearing it on a clean tree would throw away what the janitor found.
   */
  it("keeps a secret marker it has no way to observe", async () => {
    const sessionManager = makeSessionManager({ id: "s1", workspaceBlock: "secret" });
    const onSessionsChanged = vi.fn();

    await refreshWorkspaceBlockOnActivation(
      { sessionManager, createGitManager: cleanGit, onSessionsChanged },
      "s1",
      "/ws",
    );

    expect(sessionManager.state.workspaceBlock).toBe("secret");
    expect(onSessionsChanged).not.toHaveBeenCalled();
  });

  it("stays quiet when the marker already says what the check found", async () => {
    const sessionManager = makeSessionManager({ id: "s1", workspaceBlock: "conflict" });
    const onSessionsChanged = vi.fn();

    await refreshWorkspaceBlockOnActivation(
      { sessionManager, createGitManager: () => makeGit({ sequencerInProgress: true }), onSessionsChanged },
      "s1",
      "/ws",
    );

    expect(sessionManager.state.workspaceBlock).toBe("conflict");
    expect(onSessionsChanged).not.toHaveBeenCalled();
  });

  it("leaves ops sessions alone — nothing sweeps their checkout automatically", async () => {
    const sessionManager = makeSessionManager({ id: "s1", kind: "ops" });
    const onSessionsChanged = vi.fn();

    await refreshWorkspaceBlockOnActivation(
      { sessionManager, createGitManager: () => makeGit({ rebaseInProgress: true }), onSessionsChanged },
      "s1",
      "/ws",
    );

    expect(sessionManager.state.workspaceBlock).toBeUndefined();
    expect(onSessionsChanged).not.toHaveBeenCalled();
  });
});
