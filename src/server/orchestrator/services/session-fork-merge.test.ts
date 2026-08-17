import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { forkSession, mergeSession } from "./session-fork-merge.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";
import type { SessionManager } from "../sessions.js";

// planning#146 (analog): the root orchestrator's `git.merge` into the *active*
// session's booted clone re-roots BOTH `.git` and the worktree files it
// rewrites — so `mergeSession` must hand BOTH back to the worker uid, not just
// `.git` (handing only `.git` back left the merged worktree files root-owned and
// the non-root agent couldn't edit them). It does so via the shared
// `handWorkspaceBackToWorker` helper (`.git`/worktree/dep-dir internals unit-
// tested in session-worker-uid.test.ts). The real helper is a no-op unless the
// flag is set / chown-to-1000 is permitted (root-only), so we spy to assert the
// wiring; the real cross-uid proof is the live dev validation.
vi.mock("../session-worker-uid.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's importOriginal generic requires an inline import() type
  const actual = await importOriginal<typeof import("../session-worker-uid.js")>();
  return { ...actual, handWorkspaceBackToWorker: vi.fn() };
});
// nikzlabs/shipit#2349: that same merge rewrites the active worktree through the
// ORCHESTRATOR's git, whose LFS smudge filter is disabled by design, so every
// LFS-tracked path it touched is left as ~130-byte pointer text in a tree that
// reports clean. The restore's real behaviour is proven end-to-end against a
// real git-lfs in `git-lfs.test.ts`; here we assert `mergeSession` wires it.
vi.mock("../git-lfs.js", () => ({
  restoreLfsAfterTreeRewrite: vi.fn(() =>
    Promise.resolve({ status: "not-an-lfs-repo" as const, usesLfs: false }),
  ),
  // `forkSession` calls this too; the fork tests below care about refs, not LFS.
  materializeLfsWithWarning: vi.fn(() =>
    Promise.resolve({ status: "not-an-lfs-repo" as const, usesLfs: false }),
  ),
}));
import { restoreLfsAfterTreeRewrite } from "../git-lfs.js";

/** Bare origin + a working clone with one pushed commit on `main`. */
function setupRepoWithRemote(tmpDir: string, name: string) {
  const bareDir = path.join(tmpDir, `${name}.git`);
  const workDir = path.join(tmpDir, name);
  fs.mkdirSync(bareDir, { recursive: true });
  execSync("git init --bare -b main", { cwd: bareDir, stdio: "pipe" });
  execSync(`git clone ${bareDir} ${workDir}`, { stdio: "pipe" });
  fs.writeFileSync(path.join(workDir, "shared.txt"), "v1\n");
  execSync("git add -A && git commit -m Initial", { cwd: workDir, stdio: "pipe" });
  execSync("git push -u origin main", { cwd: workDir, stdio: "pipe" });
  return { bareDir, workDir };
}

function makeStubSessionManager(source: { branch: string; workspaceDir: string }): SessionManager {
  return {
    get: (id: string) => (id === "source-id" ? { sessionId: id, ...source } : undefined),
    list: () => [],
  } as unknown as SessionManager;
}

describe("session-fork-merge: mergeSession ownership handoff (planning#146 analog)", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    vi.mocked(restoreLfsAfterTreeRewrite).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-merge-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true"; // never open an editor for a merge commit
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hands BOTH .git and the worktree back to the worker uid after a clean merge", async () => {
    // Active + source are clones of the same bare origin (production push/fetch path).
    const { bareDir, workDir: activeDir } = setupRepoWithRemote(tmpDir, "active");
    const sourceDir = path.join(tmpDir, "source");
    execSync(`git clone ${bareDir} ${sourceDir}`, { stdio: "pipe" });
    // Source adds a NEW file on a feature branch — the merge will rewrite the
    // active worktree (bring feature.txt in), which is the ownership hazard.
    execSync("git checkout -b feature", { cwd: sourceDir, stdio: "pipe" });
    fs.writeFileSync(path.join(sourceDir, "feature.txt"), "feature\n");
    execSync("git add -A && git commit -m Feature", { cwd: sourceDir, stdio: "pipe" });

    const result = await mergeSession(
      makeStubSessionManager({ branch: "feature", workspaceDir: sourceDir }),
      (dir) => new GitManager(dir),
      activeDir,
      "source-id",
    );

    expect(result.success).toBe(true);
    // The merge actually rewrote the active worktree.
    expect(fs.existsSync(path.join(activeDir, "feature.txt"))).toBe(true);
    // Both handoffs fired against the ACTIVE session dir.
    expect(handWorkspaceBackToWorker).toHaveBeenCalledWith(activeDir);
    // nikzlabs/shipit#2349 — and the merged LFS assets were restored, not left as
    // pointer text for the next turn to consume.
    expect(restoreLfsAfterTreeRewrite).toHaveBeenCalledWith(
      activeDir,
      expect.any(String),
      expect.any(Function),
    );
  });

  it("hands ownership back even when the merge throws (finally runs)", async () => {
    const { bareDir, workDir: activeDir } = setupRepoWithRemote(tmpDir, "active");
    const sourceDir = path.join(tmpDir, "source");
    execSync(`git clone ${bareDir} ${sourceDir}`, { stdio: "pipe" });
    execSync("git checkout -b feature", { cwd: sourceDir, stdio: "pipe" });
    fs.writeFileSync(path.join(sourceDir, "feature.txt"), "from-source\n");
    execSync("git add -A && git commit -m Feature", { cwd: sourceDir, stdio: "pipe" });
    // Active has an UNTRACKED feature.txt — `git merge` refuses ("untracked
    // working tree files would be overwritten"), so GitManager.merge re-throws
    // (no conflicted entries to swallow). The merge ran git ops against the
    // clone, so the finally MUST still hand ownership back.
    fs.writeFileSync(path.join(activeDir, "feature.txt"), "untracked-local\n");

    await expect(
      mergeSession(
        makeStubSessionManager({ branch: "feature", workspaceDir: sourceDir }),
        (dir) => new GitManager(dir),
        activeDir,
        "source-id",
      ),
    ).rejects.toThrow();

    expect(handWorkspaceBackToWorker).toHaveBeenCalledWith(activeDir);
  });
});

/**
 * A fork is a SIBLING of its parent, not a child of it: it targets the repo's
 * default branch, exactly as the parent does.
 *
 * `git clone --local` sets the new clone's `refs/remotes/origin/HEAD` from the
 * SOURCE's checked-out branch, which for a fork is the parent session's own
 * `shipit/<slug>`. Nothing downstream refreshes it, and it is the ref
 * `GitManager.getDefaultBranch()` reads — so the fork used to open its PR
 * against the parent's branch and render "Sync with shipit/<parent-slug>".
 */
describe("session-fork-merge: forkSession base-branch inheritance", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-base-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A bare origin whose default branch is `defaultBranch`, plus a session-shaped
   *  clone sitting on its own pushed `shipit/<slug>` branch. */
  function setupParentOnFeatureBranch(defaultBranch: string) {
    const bareDir = path.join(tmpDir, "origin.git");
    const seedDir = path.join(tmpDir, "seed");
    const parentDir = path.join(tmpDir, "parent");
    fs.mkdirSync(bareDir, { recursive: true });
    execSync(`git init --bare -b ${defaultBranch}`, { cwd: bareDir, stdio: "pipe" });
    // Seed the remote from a throwaway clone, THEN clone the parent from the
    // populated repo. Cloning an empty repo writes no `refs/remotes/origin/HEAD`
    // at all, so a parent built that way would not have the ref this test is
    // about — production clones from a bare cache that always has commits.
    execSync(`git clone ${bareDir} ${seedDir}`, { stdio: "pipe" });
    fs.writeFileSync(path.join(seedDir, "shared.txt"), "v1\n");
    execSync("git add -A && git commit -m Initial", { cwd: seedDir, stdio: "pipe" });
    execSync(`git push -u origin ${defaultBranch}`, { cwd: seedDir, stdio: "pipe" });
    execSync(`git clone ${bareDir} ${parentDir}`, { stdio: "pipe" });
    // The parent then does what every ShipIt session does: cut its own branch and
    // push it. The push matters — a parent branch that exists on the remote
    // SURVIVES the fork's `fetch --prune`, so a stale `origin/HEAD` stays
    // resolvable and silently wins.
    execSync("git checkout -b shipit/parent-desc", { cwd: parentDir, stdio: "pipe" });
    fs.writeFileSync(path.join(parentDir, "work.txt"), "parent work\n");
    execSync("git add -A && git commit -m Work", { cwd: parentDir, stdio: "pipe" });
    execSync("git push -u origin shipit/parent-desc", { cwd: parentDir, stdio: "pipe" });
    return { bareDir, parentDir };
  }

  interface StubRow { id: string; title: string; workspaceDir?: string; branch?: string; remoteUrl?: string }

  /** In-memory SessionManager covering only what forkSession + graduateSession touch. */
  function makeForkSessionManager(parent: StubRow) {
    const rows = new Map<string, StubRow>([[parent.id, { ...parent }]]);
    const upsert = (id: string, patch: Partial<StubRow>) =>
      rows.set(id, { id, title: "", ...rows.get(id), ...patch });
    return {
      rows,
      manager: {
        get: (id: string) => rows.get(id),
        list: () => [...rows.values()],
        track: (id: string, title?: string, workspaceDir?: string) =>
          upsert(id, { ...(title ? { title } : {}), ...(workspaceDir ? { workspaceDir } : {}) }),
        setBranch: (id: string, branch: string) => upsert(id, { branch }),
        setRemoteUrl: (id: string, remoteUrl: string) => upsert(id, { remoteUrl }),
        setWarm: () => {},
        rename: (id: string, title: string) => upsert(id, { title }),
        setBranchRenamed: () => {},
      } as unknown as SessionManager,
    };
  }

  async function fork(parentDir: string, parentRow: StubRow) {
    const { rows, manager } = makeForkSessionManager(parentRow);
    const sessionsRoot = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    const result = await forkSession(
      manager,
      (dir) => ({ dir }) as never,
      () => "",
      sessionsRoot,
      { authenticated: false, configureGitCredentials: () => {} },
      { init: () => {} },
      parentRow.id,
      parentDir,
      "shipit/forkslug",
      undefined,
      "Forked",
      {
        sessionManager: manager,
        runnerRegistry: { get: () => undefined } as never,
        repoStore: { touch: () => {} } as never,
        createGitManager: (dir: string) => new GitManager(dir),
        sseBroadcast: () => {},
      },
    );
    return { result, rows };
  }

  it("targets the repo's default branch, not the parent session's branch", async () => {
    const { bareDir, parentDir } = setupParentOnFeatureBranch("main");
    const { result } = await fork(parentDir, {
      id: "parent-id", title: "Parent", workspaceDir: parentDir,
      branch: "shipit/parent-desc", remoteUrl: bareDir,
    });

    // The fixture is honest only if the parent itself answers "main" while
    // sitting on its own branch — that is the value the fork has to inherit.
    expect(await new GitManager(parentDir).getDefaultBranch()).toBe("main");

    const forkDir = result.session.workspaceDir!;
    const forkGit = new GitManager(forkDir);
    expect(await forkGit.getDefaultBranch()).toBe("main");
    // And the fork is genuinely on its own branch, off the parent's.
    expect(await forkGit.getCurrentBranch()).toBe("shipit/forkslug");
  });

  it("carries a non-main default branch across the fork", async () => {
    // The whole reason for copying the parent's `origin/HEAD` rather than
    // deleting it and probing: a probe only knows `main` and `master`.
    const { bareDir, parentDir } = setupParentOnFeatureBranch("trunk");
    const { result } = await fork(parentDir, {
      id: "parent-id", title: "Parent", workspaceDir: parentDir,
      branch: "shipit/parent-desc", remoteUrl: bareDir,
    });

    expect(await new GitManager(result.session.workspaceDir!).getDefaultBranch()).toBe("trunk");
  });

  it("drops the inherited origin/HEAD when the parent has none (no remote)", async () => {
    // A sandbox session: `git init`, no origin at all. The fork must not be left
    // pointing at the parent's branch just because there was nothing to copy.
    const parentDir = path.join(tmpDir, "sandbox");
    fs.mkdirSync(parentDir, { recursive: true });
    execSync("git init -b main", { cwd: parentDir, stdio: "pipe" });
    fs.writeFileSync(path.join(parentDir, "a.txt"), "a\n");
    execSync("git add -A && git commit -m Initial", { cwd: parentDir, stdio: "pipe" });
    execSync("git checkout -b shipit/parent-desc", { cwd: parentDir, stdio: "pipe" });
    fs.writeFileSync(path.join(parentDir, "b.txt"), "b\n");
    execSync("git add -A && git commit -m More", { cwd: parentDir, stdio: "pipe" });

    const { result } = await fork(parentDir, {
      id: "parent-id", title: "Sandbox", workspaceDir: parentDir, branch: "shipit/parent-desc",
    });

    const forkDir = result.session.workspaceDir!;
    expect(() =>
      execSync("git symbolic-ref refs/remotes/origin/HEAD", { cwd: forkDir, stdio: "pipe" }),
    ).toThrow();
    expect(await new GitManager(forkDir).getDefaultBranch()).not.toBe("shipit/parent-desc");
  });
});
