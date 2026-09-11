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

vi.mock("../session-worker-uid.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's importOriginal generic requires an inline import() type
  const actual = await importOriginal<typeof import("../session-worker-uid.js")>();
  return { ...actual, handWorkspaceBackToWorker: vi.fn() };
});
vi.mock("../git-lfs.js", () => ({
  restoreLfsAfterTreeRewrite: vi.fn(() =>
    Promise.resolve({ status: "not-an-lfs-repo" as const, usesLfs: false }),
  ),
  materializeLfsWithWarning: vi.fn(() =>
    Promise.resolve({ status: "not-an-lfs-repo" as const, usesLfs: false }),
  ),
  buildLfsUnresolvedAgentNotice: vi.fn(() => "[System] LFS-UNRESOLVED-NOTICE"),
}));
import { restoreLfsAfterTreeRewrite, materializeLfsWithWarning } from "../git-lfs.js";
vi.mock("../../shared/git-remote-credential.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's importOriginal generic requires an inline import() type
  const actual = await importOriginal<typeof import("../../shared/git-remote-credential.js")>();
  return { ...actual, resolveTreeRemoteCredential: vi.fn(actual.resolveTreeRemoteCredential) };
});
import { resolveTreeRemoteCredential } from "../../shared/git-remote-credential.js";

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
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hands BOTH .git and the worktree back to the worker uid after a clean merge", async () => {
    const { bareDir, workDir: activeDir } = setupRepoWithRemote(tmpDir, "active");
    const sourceDir = path.join(tmpDir, "source");
    execSync(`git clone ${bareDir} ${sourceDir}`, { stdio: "pipe" });
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
    expect(fs.existsSync(path.join(activeDir, "feature.txt"))).toBe(true);
    expect(handWorkspaceBackToWorker).toHaveBeenCalledWith(activeDir);
    expect(restoreLfsAfterTreeRewrite).toHaveBeenCalledWith(
      activeDir,
      expect.any(String),
      expect.any(Function),
    );
  });

  it("merges from origin when the source session's checkout has been evicted", async () => {
    // The disk janitor reclaims an idle session's tree, and only ever after its branch
    // reached the remote. `new GitManager(<absent dir>)` throws synchronously, so an
    // unguarded construction turned this whole merge into an HTTP 500.
    const { bareDir, workDir: activeDir } = setupRepoWithRemote(tmpDir, "active");
    const sourceDir = path.join(tmpDir, "source");
    execSync(`git clone ${bareDir} ${sourceDir}`, { stdio: "pipe" });
    execSync("git checkout -b feature", { cwd: sourceDir, stdio: "pipe" });
    fs.writeFileSync(path.join(sourceDir, "feature.txt"), "feature\n");
    execSync("git add -A && git commit -m Feature", { cwd: sourceDir, stdio: "pipe" });
    execSync("git push -u origin feature", { cwd: sourceDir, stdio: "pipe" });
    fs.rmSync(sourceDir, { recursive: true, force: true });

    const result = await mergeSession(
      makeStubSessionManager({ branch: "feature", workspaceDir: sourceDir }),
      (dir) => new GitManager(dir),
      activeDir,
      "source-id",
    );

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(activeDir, "feature.txt"), "utf8")).toBe("feature\n");
  });

  it("hands ownership back even when the merge throws (finally runs)", async () => {
    const { bareDir, workDir: activeDir } = setupRepoWithRemote(tmpDir, "active");
    const sourceDir = path.join(tmpDir, "source");
    execSync(`git clone ${bareDir} ${sourceDir}`, { stdio: "pipe" });
    execSync("git checkout -b feature", { cwd: sourceDir, stdio: "pipe" });
    fs.writeFileSync(path.join(sourceDir, "feature.txt"), "from-source\n");
    execSync("git add -A && git commit -m Feature", { cwd: sourceDir, stdio: "pipe" });
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

  function setupParentOnFeatureBranch(defaultBranch: string) {
    const bareDir = path.join(tmpDir, "origin.git");
    const seedDir = path.join(tmpDir, "seed");
    const parentDir = path.join(tmpDir, "parent");
    fs.mkdirSync(bareDir, { recursive: true });
    execSync(`git init --bare -b ${defaultBranch}`, { cwd: bareDir, stdio: "pipe" });
    // An empty clone has no origin/HEAD, so seed the remote first.
    execSync(`git clone ${bareDir} ${seedDir}`, { stdio: "pipe" });
    fs.writeFileSync(path.join(seedDir, "shared.txt"), "v1\n");
    execSync("git add -A && git commit -m Initial", { cwd: seedDir, stdio: "pipe" });
    execSync(`git push -u origin ${defaultBranch}`, { cwd: seedDir, stdio: "pipe" });
    execSync(`git clone ${bareDir} ${parentDir}`, { stdio: "pipe" });
    // Push the parent branch so fetch --prune cannot remove the incorrect target.
    execSync("git checkout -b shipit/parent-desc", { cwd: parentDir, stdio: "pipe" });
    fs.writeFileSync(path.join(parentDir, "work.txt"), "parent work\n");
    execSync("git add -A && git commit -m Work", { cwd: parentDir, stdio: "pipe" });
    execSync("git push -u origin shipit/parent-desc", { cwd: parentDir, stdio: "pipe" });
    return { bareDir, parentDir };
  }

  interface StubRow { id: string; title: string; workspaceDir?: string; branch?: string; remoteUrl?: string }

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

    expect(await new GitManager(parentDir).getDefaultBranch()).toBe("main");

    const forkDir = result.session.workspaceDir!;
    const forkGit = new GitManager(forkDir);
    expect(await forkGit.getDefaultBranch()).toBe("main");
    expect(await forkGit.getCurrentBranch()).toBe("shipit/forkslug");
  });

  it("reads the bare cache's HEAD in preference to the parent's, healing a fork of a fork", async () => {
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
    const { bareDir, parentDir } = setupParentOnFeatureBranch("trunk");
    const { result } = await fork(parentDir, {
      id: "parent-id", title: "Parent", workspaceDir: parentDir,
      branch: "shipit/parent-desc", remoteUrl: bareDir,
    });

    expect(await new GitManager(result.session.workspaceDir!).getDefaultBranch()).toBe("trunk");
  });

  it("drops the inherited origin/HEAD when the parent has none (no remote)", async () => {
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
    vi.mocked(materializeLfsWithWarning).mockResolvedValueOnce({
      status: "failed", usesLfs: true, failure: "no-credential",
      warning: "git lfs pull exited 2: could not read Username",
    });

    const { result, notices } = await forkWithReport(parentDir, remoteUrl);

    expect(result.session.workspaceDir).toBeTruthy();
    expect(notices).toHaveLength(1);
    expect(notices[0].sessionId).toBe(result.session.id);
    expect(notices[0].sessionId).not.toBe("parent-id");
    expect(notices[0].notice).toBe("[System] LFS-UNRESOLVED-NOTICE");
  });

  it("parks a notice for every non-materialized status, not just a failed pull", async () => {
    for (const status of ["disabled", "binary-missing", "failed"] as const) {
      const { parentDir, remoteUrl } = setupParent(status);
      vi.mocked(materializeLfsWithWarning).mockResolvedValueOnce({ status, usesLfs: true });
      const { notices } = await forkWithReport(parentDir, remoteUrl);
      expect(notices, `status ${status} must be reported`).toHaveLength(1);
    }
  });

  it("says nothing when the content materialized, or the repo does not use LFS", async () => {
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

  it("resolves a credential for its `fetch origin`, scoped to its own workspace", async () => {
    const { parentDir } = setupParent("cred");
    const remoteUrl = "https://github.com/acme/widgets.git";
    const resolver: GitRemoteCredentialResolver = () => Promise.resolve(null);
    const { result } = await forkWithReport(parentDir, remoteUrl, resolver);

    expect(resolveTreeRemoteCredential).toHaveBeenCalledWith(
      result.session.workspaceDir,
      "origin",
      resolver,
    );
  });

  it("does not resolve one when the parent has no remote at all", async () => {
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
