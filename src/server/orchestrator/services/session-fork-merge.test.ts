import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { mergeSession } from "./session-fork-merge.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";
import type { SessionManager } from "../sessions.js";

// SHI-144 (analog): the root orchestrator's `git.merge` into the *active*
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

describe("session-fork-merge: mergeSession ownership handoff (SHI-144 analog)", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
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
