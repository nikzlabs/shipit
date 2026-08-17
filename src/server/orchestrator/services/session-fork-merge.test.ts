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
import type { GitRemoteCredentialResolver } from "../../shared/git-remote-credential.js";

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
  // planning#426 — the notice text itself is asserted in `git-lfs.test.ts` against
  // the real builder; here it only needs to be a recognisable marker so the
  // WIRING (a non-materialized result reaches the new session) is what is tested.
  buildLfsUnresolvedAgentNotice: vi.fn(() => "[System] LFS-UNRESOLVED-NOTICE"),
}));
import { restoreLfsAfterTreeRewrite, materializeLfsWithWarning } from "../git-lfs.js";
// planning#426 — `forkSession`'s `fetch origin` must resolve a credential of its
// own. The DECISION to resolve is `resolveTreeRemoteCredential`'s and is proven
// against the dropped-uid fake in `shared/git-remote-credential-wiring.test.ts`;
// what has to hold here is that the fork REACHES it, for its own workspace and
// its own `origin`. The real implementation is kept — it correctly answers "no
// drop applies" in a test process, so every git op below runs its unchanged path.
vi.mock("../../shared/git-remote-credential.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's importOriginal generic requires an inline import() type
  const actual = await importOriginal<typeof import("../../shared/git-remote-credential.js")>();
  return { ...actual, resolveTreeRemoteCredential: vi.fn(actual.resolveTreeRemoteCredential) };
});
import { resolveTreeRemoteCredential } from "../../shared/git-remote-credential.js";

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

  /**
   * @param cacheDir the shared bare cache `getBareCacheDir` should resolve to.
   *   Pass a nonexistent path to exercise the parent-copy fallback.
   */
  async function fork(parentDir: string, parentRow: StubRow, cacheDir = path.join(tmpDir, "no-such-cache")) {
    const { rows, manager } = makeForkSessionManager(parentRow);
    const sessionsRoot = path.join(path.dirname(parentDir), "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    const result = await forkSession(
      manager,
      (dir) => ({ dir }) as never,
      () => cacheDir,
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
    }, bareDir);

    // The fixture is honest only if the parent itself answers "main" while
    // sitting on its own branch — that is the value the fork must end up with.
    expect(await new GitManager(parentDir).getDefaultBranch()).toBe("main");

    const forkDir = result.session.workspaceDir!;
    const forkGit = new GitManager(forkDir);
    expect(await forkGit.getDefaultBranch()).toBe("main");
    // And the fork is genuinely on its own branch, off the parent's.
    expect(await forkGit.getCurrentBranch()).toBe("shipit/forkslug");
  });

  it("reads the bare cache's HEAD in preference to the parent's, healing a fork of a fork", async () => {
    // A parent that is ITSELF a fork made before this fix carries the wrong
    // `origin/HEAD`. Copying from the parent would propagate that down the
    // lineage forever; the cache can never name a `shipit/...` branch.
    const { bareDir, parentDir } = setupParentOnFeatureBranch("main");
    execSync("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/shipit/parent-desc", {
      cwd: parentDir, stdio: "pipe",
    });
    expect(await new GitManager(parentDir).getDefaultBranch()).toBe("shipit/parent-desc");

    const { result } = await fork(parentDir, {
      id: "parent-id", title: "Parent", workspaceDir: parentDir,
      branch: "shipit/parent-desc", remoteUrl: bareDir,
    }, bareDir);

    expect(await new GitManager(result.session.workspaceDir!).getDefaultBranch()).toBe("main");
  });

  it("falls back to the parent's origin/HEAD when no bare cache is on disk", async () => {
    // A reclaimed cache, or a local/dogfood setup that never built one. `trunk`
    // is the case that proves the fallback is a real read: deleting the ref and
    // letting `getDefaultBranch()` probe would answer `main`, since the probe
    // only knows `main` and `master`.
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

/**
 * planning#426 — a fork of an LFS repository silently got pointer stubs.
 *
 * Two halves, and the second is a defect on its own terms even when the first
 * turns out to be legitimate ("the token has no access to this repository"):
 *
 *  1. The `fetch origin` and the `git lfs pull` are remote ops on a SESSION
 *     workspace, so since docs/266-orchestrator-git-trust-boundary E1 they run at
 *     dropped uid and cannot read the orchestrator's PAT. `mergeSession` already
 *     took a resolver for this; `forkSession` did not.
 *  2. Whatever the cause, the fork must not present as COMPLETE. A stub looks
 *     like the file and git calls the tree clean, so every downstream read gets
 *     plausible wrong data rather than a missing file.
 */
describe("session-fork-merge: forkSession reports unresolved LFS content (planning#426)", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    vi.mocked(materializeLfsWithWarning).mockClear();
    vi.mocked(resolveTreeRemoteCredential).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-lfs-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  interface Row { id: string; title: string; workspaceDir?: string; branch?: string; remoteUrl?: string }

  /**
   * A parent session-shaped clone with a local bare origin, on its own branch.
   *
   * `name` scopes each fixture to its own subdirectory so a test can build several
   * without recreating `tmpDir` — the global gitconfig (and therefore the commit
   * identity) lives under it, so tearing it down mid-test loses the identity.
   */
  function setupParent(name = "a"): { parentDir: string; remoteUrl: string } {
    const remoteUrl = path.join(tmpDir, name, "origin.git");
    fs.mkdirSync(path.join(tmpDir, name), { recursive: true });
    execSync(`git init --bare -b main ${remoteUrl}`, { stdio: "pipe" });
    const parentDir = path.join(tmpDir, name, "parent");
    execSync(`git clone ${remoteUrl} ${parentDir}`, { stdio: "pipe" });
    fs.writeFileSync(path.join(parentDir, "a.txt"), "a\n");
    execSync("git add -A && git commit -m Initial", { cwd: parentDir, stdio: "pipe" });
    execSync("git push -u origin main", { cwd: parentDir, stdio: "pipe" });
    execSync("git checkout -b shipit/parent-desc", { cwd: parentDir, stdio: "pipe" });
    return { parentDir, remoteUrl };
  }

  async function forkWithReport(
    parentDir: string,
    remoteUrl: string,
    resolveRemoteCredential?: GitRemoteCredentialResolver,
  ) {
    const rows = new Map<string, Row>([[
      "parent-id",
      { id: "parent-id", title: "Parent", workspaceDir: parentDir, branch: "shipit/parent-desc", remoteUrl },
    ]]);
    const upsert = (id: string, patch: Partial<Row>) =>
      rows.set(id, { id, title: "", ...rows.get(id), ...patch });
    const notices: { sessionId: string; notice: string }[] = [];
    const warnings: string[] = [];
    const manager = {
      get: (id: string) => rows.get(id),
      list: () => [...rows.values()],
      track: (id: string, title?: string, workspaceDir?: string) =>
        upsert(id, { ...(title ? { title } : {}), ...(workspaceDir ? { workspaceDir } : {}) }),
      setBranch: (id: string, branch: string) => upsert(id, { branch }),
      setRemoteUrl: (id: string, url: string) => upsert(id, { remoteUrl: url }),
      setWarm: () => {},
      rename: (id: string, title: string) => upsert(id, { title }),
      setBranchRenamed: () => {},
    } as unknown as SessionManager;

    const sessionsRoot = path.join(path.dirname(parentDir), "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    const result = await forkSession(
      manager,
      (dir) => ({ dir }) as never,
      () => path.join(tmpDir, "no-such-cache"),
      sessionsRoot,
      { authenticated: false, configureGitCredentials: () => {} },
      { init: () => {} },
      "parent-id",
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
      resolveRemoteCredential,
      {
        warn: (message) => warnings.push(message),
        noticeForAgent: (sessionId, notice) => notices.push({ sessionId, notice }),
      },
    );
    return { result, notices, warnings };
  }

  it("parks a notice on the NEW session when the pull left stubs behind", async () => {
    const { parentDir, remoteUrl } = setupParent();
    // The pull failed with no credential — the shape the planning#410 soak saw 46
    // times. The real pull, its argv and its classification are covered against a
    // real git-lfs in `git-lfs.test.ts`; what has to hold HERE is that a
    // non-materialized result reaches the fork's first turn instead of a log line.
    vi.mocked(materializeLfsWithWarning).mockResolvedValueOnce({
      status: "failed", usesLfs: true, failure: "no-credential",
      warning: "git lfs pull exited 2: could not read Username",
    });

    const { result, notices } = await forkWithReport(parentDir, remoteUrl);

    // The fork still completed — provisioning must not fail over an asset problem.
    expect(result.session.workspaceDir).toBeTruthy();
    // …and it does not present as complete. Addressed to the NEW session, because
    // it is the fork's tree that holds the stubs, not the parent's.
    expect(notices).toHaveLength(1);
    expect(notices[0].sessionId).toBe(result.session.id);
    expect(notices[0].sessionId).not.toBe("parent-id");
    expect(notices[0].notice).toBe("[System] LFS-UNRESOLVED-NOTICE");
  });

  it("parks a notice for every non-materialized status, not just a failed pull", async () => {
    // `disabled` and `binary-missing` leave stubs on disk exactly as a failed pull
    // does, so gating the notice on `status === "failed"` would have been wrong.
    for (const status of ["disabled", "binary-missing", "failed"] as const) {
      const { parentDir, remoteUrl } = setupParent(status);
      vi.mocked(materializeLfsWithWarning).mockResolvedValueOnce({ status, usesLfs: true });
      const { notices } = await forkWithReport(parentDir, remoteUrl);
      expect(notices, `status ${status} must be reported`).toHaveLength(1);
    }
  });

  it("says nothing when the content materialized, or the repo does not use LFS", async () => {
    // The negative half. Without it, every fork could carry a warning nobody can
    // act on, which is the fastest way to make the real one ignorable.
    for (const result of [
      { status: "materialized" as const, usesLfs: true },
      { status: "not-an-lfs-repo" as const, usesLfs: false },
    ]) {
      const { parentDir, remoteUrl } = setupParent(result.status);
      vi.mocked(materializeLfsWithWarning).mockResolvedValueOnce(result);
      const { notices, warnings } = await forkWithReport(parentDir, remoteUrl);
      expect(notices, `status ${result.status} must stay silent`).toEqual([]);
      expect(warnings).toEqual([]);
    }
  });

  // The plumbing half. `mergeSession` has taken a resolver since docs/266 E3;
  // `forkSession` was the raw site left behind, so its `fetch origin` ran with the
  // global helper only — which on a dropped-uid git answers nothing, and then falls
  // through to the workspace-LOCAL helper: the container's broker binary, which
  // does not exist on the orchestrator. Hence `could not read Username`.
  it("resolves a credential for its `fetch origin`, scoped to its own workspace", async () => {
    const { parentDir } = setupParent("cred");
    const remoteUrl = "https://github.com/acme/widgets.git";
    const resolver: GitRemoteCredentialResolver = () => Promise.resolve(null);
    const { result } = await forkWithReport(parentDir, remoteUrl, resolver);

    // The fork's OWN workspace, not the parent's — a credential resolved against
    // the parent tree would read the wrong `origin` and the wrong owner.
    expect(resolveTreeRemoteCredential).toHaveBeenCalledWith(
      result.session.workspaceDir,
      "origin",
      resolver,
    );
  });

  it("does not resolve one when the parent has no remote at all", async () => {
    // A sandbox parent: `git init`, no origin. There is nothing to authenticate to,
    // and offering a credential to a local path would be the host confusion
    // `parseRemoteOrigin` declines on purpose.
    const parentDir = path.join(tmpDir, "sandbox");
    fs.mkdirSync(parentDir, { recursive: true });
    execSync("git init -b main", { cwd: parentDir, stdio: "pipe" });
    fs.writeFileSync(path.join(parentDir, "a.txt"), "a\n");
    execSync("git add -A && git commit -m Initial", { cwd: parentDir, stdio: "pipe" });
    execSync("git checkout -b shipit/parent-desc", { cwd: parentDir, stdio: "pipe" });

    const rows = new Map([["parent-id", {
      id: "parent-id", title: "Parent", workspaceDir: parentDir, branch: "shipit/parent-desc",
    }]]);
    const manager = {
      get: (id: string) => rows.get(id),
      list: () => [...rows.values()],
      track: () => {}, setBranch: () => {}, setRemoteUrl: () => {},
      setWarm: () => {}, rename: () => {}, setBranchRenamed: () => {},
    } as unknown as SessionManager;
    const sessionsRoot = path.join(tmpDir, "sandbox-sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });

    await forkSession(
      manager, (dir) => ({ dir }) as never, () => path.join(tmpDir, "no-such-cache"),
      sessionsRoot, { authenticated: false, configureGitCredentials: () => {} },
      { init: () => {} }, "parent-id", parentDir, "shipit/forkslug", undefined, "Forked",
      {
        sessionManager: manager,
        runnerRegistry: { get: () => undefined } as never,
        repoStore: { touch: () => {} } as never,
        createGitManager: (dir: string) => new GitManager(dir),
        sseBroadcast: () => {},
      },
      () => Promise.resolve(null),
    );

    expect(resolveTreeRemoteCredential).not.toHaveBeenCalled();
  });
});
