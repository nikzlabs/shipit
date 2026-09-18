/**
 * docs/298-broken-workspace-visibility — the open-time half of the marker: the disk
 * janitor only ever looks at a session idle enough to evict, so a session the user
 * has open was the one case nothing evaluated.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitManager } from "../../shared/git.js";
import type { SessionInfo, WorkspaceBlockKind } from "../../shared/types.js";
import { refreshWorkspaceBlockOnActivation, sweepWorkspaceBlocksAtStartup } from "./workspace-block.js";

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

function treeReaders(tree: {
  clean?: boolean;
  conflictedFiles?: string[];
  unreadable?: { kind: "omitted" | "blocked"; detail: string } | null;
  rebaseInProgress?: boolean;
  sequencerInProgress?: boolean;
}) {
  return {
    inspectWorkingTree: () => Promise.resolve({
      clean: tree.clean ?? true,
      conflictedFiles: tree.conflictedFiles ?? [],
      unreadable: tree.unreadable ?? null,
    }),
    isRebaseInProgress: () => Promise.resolve(tree.rebaseInProgress ?? false),
    isMergeOrSequencerInProgress: () => Promise.resolve(tree.sequencerInProgress ?? false),
  };
}

function makeGit(tree: Parameters<typeof treeReaders>[0]): GitManager {
  return treeReaders(tree) as unknown as GitManager;
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

function makeSessionList(sessions: (Partial<SessionInfo> & { id: string })[]) {
  const state = sessions.map((s) => ({ ...s }) as SessionInfo);
  return {
    state,
    listAll: () => state,
    get: (id: string) => state.find((s) => s.id === id),
    setWorkspaceBlock: (id: string, kind: WorkspaceBlockKind | null): boolean => {
      const session = state.find((s) => s.id === id);
      if (!session) return false;
      const next = kind ?? undefined;
      if (session.workspaceBlock === next) return false;
      session.workspaceBlock = next;
      return true;
    },
  };
}

/**
 * docs/298 — the third writer: one pass after boot, because the janitor only ever
 * inspects a checkout it is about to evict and activation needs the user to open
 * the tab.
 */
describe("sweepWorkspaceBlocksAtStartup", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await chmod(root, 0o755).catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
    vi.restoreAllMocks();
  });

  async function makeCheckout(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "workspace-sweep-"));
    roots.push(root);
    await mkdir(join(root, ".git"));
    return root;
  }

  function makeWriteSpies() {
    return { autoCommit: vi.fn(), push: vi.fn() };
  }

  function gitFactory(
    tree: Parameters<typeof treeReaders>[0],
    extra: Record<string, unknown> = {},
  ): { create: (dir: string) => GitManager; writes: ReturnType<typeof makeWriteSpies> } {
    const writes = makeWriteSpies();
    return {
      writes,
      create: () => ({ ...treeReaders(tree), ...writes, ...extra }) as unknown as GitManager,
    };
  }

  /**
   * The single most important property of this trigger: a redeploy inspects, it
   * never repairs. `ensureCheckoutDurable` would commit and push whatever the user
   * left in their tree merely because the orchestrator restarted.
   */
  it("never commits the work a redeploy found uncommitted", async () => {
    const dir = await makeCheckout();
    const sessionManager = makeSessionList([{ id: "s1", workspaceDir: dir, diskTier: "hot" }]);
    // Dirty as well as conflicted: `ensureCheckoutDurable` reaches `autoCommit`
    // only on a tree that has something to commit.
    const git = gitFactory({ clean: false, rebaseInProgress: true });

    await sweepWorkspaceBlocksAtStartup({ sessionManager, createGitManager: git.create });

    expect(git.writes.autoCommit).not.toHaveBeenCalled();
  });

  // Clean but unpushed: the one shape whose durability check ends at `git push`.
  it("never pushes a branch whose tip is not on origin", async () => {
    const dir = await makeCheckout();
    const sessionManager = makeSessionList([{ id: "s1", workspaceDir: dir, diskTier: "hot" }]);
    const git = gitFactory({}, {
      currentBranchOrNull: () => Promise.resolve("shipit/abc123"),
      getHeadHash: () => Promise.resolve("aaaa"),
      getRefHash: () => Promise.resolve(null),
      isAncestor: () => Promise.resolve(false),
    });

    await sweepWorkspaceBlocksAtStartup({ sessionManager, createGitManager: git.create });

    expect(git.writes.push).not.toHaveBeenCalled();
  });

  it("marks a hot session stuck mid-rebase and re-broadcasts the session list", async () => {
    const dir = await makeCheckout();
    const sessionManager = makeSessionList([{ id: "s1", workspaceDir: dir, diskTier: "hot" }]);
    const onSessionsChanged = vi.fn();

    const result = await sweepWorkspaceBlocksAtStartup({
      sessionManager,
      createGitManager: gitFactory({ rebaseInProgress: true }).create,
      onSessionsChanged,
    });

    expect(sessionManager.state[0]!.workspaceBlock).toBe("conflict");
    expect(onSessionsChanged).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ checked: 1, blocked: 1, cleared: 0, skipped: 0 });
  });

  it("withdraws the marker from a checkout that was repaired, and re-broadcasts", async () => {
    const dir = await makeCheckout();
    const sessionManager = makeSessionList([
      { id: "s1", workspaceDir: dir, diskTier: "light", workspaceBlock: "conflict" },
    ]);
    const onSessionsChanged = vi.fn();

    const result = await sweepWorkspaceBlocksAtStartup({
      sessionManager,
      createGitManager: gitFactory({}).create,
      onSessionsChanged,
    });

    expect(sessionManager.state[0]!.workspaceBlock).toBeUndefined();
    expect(onSessionsChanged).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ checked: 1, blocked: 0, cleared: 1 });
  });

  // A read-only inspection is no evidence at all about a secret `autoCommit` found.
  it("leaves a marker of a kind it cannot decide untouched", async () => {
    const dir = await makeCheckout();
    const sessionManager = makeSessionList([
      { id: "s1", workspaceDir: dir, diskTier: "light", workspaceBlock: "secret" },
    ]);
    const onSessionsChanged = vi.fn();

    const result = await sweepWorkspaceBlocksAtStartup({
      sessionManager,
      createGitManager: gitFactory({}).create,
      onSessionsChanged,
    });

    expect(sessionManager.state[0]!.workspaceBlock).toBe("secret");
    expect(onSessionsChanged).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 0, skipped: 1 });
  });

  it("skips evicted, workspace-less, repository-less and ops sessions without asking git", async () => {
    const withCheckout = await makeCheckout();
    const noRepo = await mkdtemp(join(tmpdir(), "workspace-sweep-"));
    roots.push(noRepo);
    const sessionManager = makeSessionList([
      { id: "evicted", workspaceDir: withCheckout, diskTier: "evicted" },
      { id: "no-dir", diskTier: "hot" },
      { id: "no-git", workspaceDir: noRepo, diskTier: "light" },
      { id: "ops", workspaceDir: withCheckout, diskTier: "hot", kind: "ops" },
    ]);
    const createGitManager = vi.fn(() => makeGit({ rebaseInProgress: true }));

    const result = await sweepWorkspaceBlocksAtStartup({ sessionManager, createGitManager });

    expect(createGitManager).not.toHaveBeenCalled();
    expect(sessionManager.state.every((s) => s.workspaceBlock === undefined)).toBe(true);
    expect(result).toMatchObject({ checked: 0, skipped: 4 });
  });

  /**
   * A `.git` the sweep could not stat is "could not ask", not "no repository": a
   * permission error is no reason to withdraw a marker the janitor earned.
   */
  it("leaves an existing marker in place when it cannot read the checkout", async () => {
    const dir = await makeCheckout();
    await chmod(dir, 0o000);
    const sessionManager = makeSessionList([
      { id: "s1", workspaceDir: dir, diskTier: "light", workspaceBlock: "conflict" },
    ]);
    const createGitManager = vi.fn(() => makeGit({}));

    const result = await sweepWorkspaceBlocksAtStartup({ sessionManager, createGitManager });

    expect(sessionManager.state[0]!.workspaceBlock).toBe("conflict");
    expect(createGitManager).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 0, skipped: 1 });
  });

  /**
   * The boot janitor pass runs beside this sweep. Eviction is terminal for the
   * marker — every later pass skips an evicted session — so an answer about a
   * checkout the janitor has since wiped would stick to the session for good.
   */
  it("does not mark a session the janitor evicted while the inspection was running", async () => {
    const dir = await makeCheckout();
    const sessionManager = makeSessionList([{ id: "s1", workspaceDir: dir, diskTier: "light" }]);
    const createGitManager = () => ({
      ...treeReaders({}),
      isRebaseInProgress: () => {
        // The janitor finishes the eviction this pass started out ahead of.
        sessionManager.state[0]!.diskTier = "evicted";
        return Promise.resolve(true);
      },
    }) as unknown as GitManager;

    const result = await sweepWorkspaceBlocksAtStartup({ sessionManager, createGitManager });

    expect(sessionManager.state[0]!.workspaceBlock).toBeUndefined();
    expect(result).toMatchObject({ checked: 1, blocked: 0 });
  });

  /**
   * The count is the operator's evidence that the sweep looked, so it must follow
   * the git reads, not the writes: `unreadable` is a kind this pass may not record,
   * and reporting `checked=0` for it would claim the checkout was never opened.
   */
  it("counts a checkout it read but may not judge as checked, not skipped", async () => {
    const dir = await makeCheckout();
    const sessionManager = makeSessionList([{ id: "s1", workspaceDir: dir, diskTier: "hot" }]);

    const result = await sweepWorkspaceBlocksAtStartup({
      sessionManager,
      createGitManager: gitFactory({ unreadable: { kind: "omitted", detail: "pgdata/" } }).create,
    });

    expect(sessionManager.state[0]!.workspaceBlock).toBeUndefined();
    expect(result).toMatchObject({ checked: 1, blocked: 0, cleared: 0, skipped: 0 });
  });

  /**
   * `recordWorkspaceBlock` is deliberately quiet on a no-op, which is right for an
   * hourly loop and wrong here: a redeploy is exactly when an operator needs "it
   * ran and found nothing" to be something they can read.
   */
  it("prints a summary even when nothing changed", async () => {
    const dir = await makeCheckout();
    const sessionManager = makeSessionList([
      { id: "s1", workspaceDir: dir, diskTier: "hot" },
      { id: "s2", diskTier: "evicted" },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await sweepWorkspaceBlocksAtStartup({ sessionManager, createGitManager: gitFactory({}).create });

    expect(log).toHaveBeenCalledWith(
      "[startup] workspace sweep: checked=1 blocked=0 cleared=0 skipped=1 failed=0",
    );
  });
});
