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

  /**
   * Overwriting is the same information loss as clearing, one step removed: a
   * `secret` downgraded to `conflict` is withdrawn entirely the next time the
   * conflict is resolved, while the secret is still there.
   */
  it("does not overwrite a secret marker with a conflict it can see", async () => {
    const sessionManager = makeSessionManager({ id: "s1", workspaceBlock: "secret" });

    await refreshWorkspaceBlockOnActivation(
      { sessionManager, createGitManager: () => makeGit({ rebaseInProgress: true }) },
      "s1",
      "/ws",
    );

    expect(sessionManager.state.workspaceBlock).toBe("secret");
  });

  /**
   * `git status` reports an omitted DIRECTORY, but an unreadable FILE looks merely
   * modified and is only found when `git add` fails — and the stored kind does not
   * say which variant it was. So a clean inspection is not evidence of repair.
   */
  it("keeps an unreadable marker, whose file variant it cannot detect", async () => {
    const sessionManager = makeSessionManager({ id: "s1", workspaceBlock: "unreadable" });

    await refreshWorkspaceBlockOnActivation(
      { sessionManager, createGitManager: cleanGit },
      "s1",
      "/ws",
    );

    expect(sessionManager.state.workspaceBlock).toBe("unreadable");
  });

  it("says nothing when it sees a block of a kind it does not own", async () => {
    const sessionManager = makeSessionManager({ id: "s1" });
    const onSessionsChanged = vi.fn();

    await refreshWorkspaceBlockOnActivation(
      {
        sessionManager,
        createGitManager: () => makeGit({ unreadable: { kind: "omitted", detail: "pgdata/" } }),
        onSessionsChanged,
      },
      "s1",
      "/ws",
    );

    expect(sessionManager.state.workspaceBlock).toBeUndefined();
    expect(onSessionsChanged).not.toHaveBeenCalled();
  });

  /**
   * The inspection awaits, and a janitor pass that started before the viewer
   * attached can land inside that window with an answer this check cannot reach.
   */
  it("does not clear a marker the janitor wrote while the inspection was running", async () => {
    const sessionManager = makeSessionManager({ id: "s1", workspaceBlock: "conflict" });
    const createGitManager = () => ({
      inspectWorkingTree: () => Promise.resolve({ clean: true, conflictedFiles: [], unreadable: null }),
      isRebaseInProgress: () => Promise.resolve(false),
      isMergeOrSequencerInProgress: async () => {
        // The janitor finishes its own durability check mid-inspection.
        sessionManager.setWorkspaceBlock("s1", "secret");
        return false;
      },
    }) as unknown as GitManager;

    await refreshWorkspaceBlockOnActivation({ sessionManager, createGitManager }, "s1", "/ws");

    expect(sessionManager.state.workspaceBlock).toBe("secret");
  });

  it("runs one inspection for a burst of activations on the same session", async () => {
    const sessionManager = makeSessionManager({ id: "s1" });
    let inspections = 0;
    const createGitManager = () => ({
      inspectWorkingTree: async () => {
        inspections++;
        await new Promise((r) => setTimeout(r, 10));
        return { clean: true, conflictedFiles: [], unreadable: null };
      },
      isRebaseInProgress: () => Promise.resolve(false),
      isMergeOrSequencerInProgress: () => Promise.resolve(false),
    }) as unknown as GitManager;

    await Promise.all([
      refreshWorkspaceBlockOnActivation({ sessionManager, createGitManager }, "s1", "/ws"),
      refreshWorkspaceBlockOnActivation({ sessionManager, createGitManager }, "s1", "/ws"),
      refreshWorkspaceBlockOnActivation({ sessionManager, createGitManager }, "s1", "/ws"),
    ]);

    expect(inspections).toBe(1);
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
