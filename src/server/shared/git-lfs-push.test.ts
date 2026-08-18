import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "./git.js";
import { pushLfsObjects, lfsDeclarationGrepArgs } from "./git-lfs-push.js";
import { safeSimpleGit } from "./git-hooks-guard.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

/**
 * Regression for the 2026-08-18 incident (session b77e02fe,
 * `nicolasalt/reward-tag`, PR 68): the orchestrator's auto-push shipped Git LFS
 * *pointers* whose objects never left the machine, GitHub rejected it with
 * `GH008: unknown Git LFS object`, and two turns' commits stayed local.
 *
 * The cause is structural, not incidental. Orchestrator git carries
 * `-c core.hooksPath=/dev/null` on every argv (planning#384, correct and
 * load-bearing), and the git-lfs `pre-push` hook is the ONLY thing an ordinary
 * `git push` uses to upload objects. The proof at the time: a manual
 * `git push origin HEAD` from the session container — same `.git`, hooks
 * enabled — succeeded as a plain fast-forward and printed
 * `Uploading LFS objects: 100% (8/8), 18 MB`.
 *
 * So the push paths now run `git lfs push` themselves. These pin the two halves
 * that matter: a repo that uses LFS gets the upload, and a repo that does not
 * pays nothing.
 */
describe("pushLfsObjects", () => {
  let root: string;
  let workDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-push-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(root, "credentials"));
    setGitIdentity("Test", "test@test.com");

    workDir = path.join(root, "work");
    fs.mkdirSync(workDir);
    run("git init -b main", workDir);
    fs.writeFileSync(path.join(workDir, "readme.md"), "hello\n");
    run("git add -A && git commit -m init", workDir);
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs nothing on a repo that tracks nothing with LFS", async () => {
    const outcome = await pushLfsObjects(safeSimpleGit(workDir), "origin", "main");
    expect(outcome.status).toBe("not-an-lfs-repo");
  });

  it("ignores a `.gitattributes` that declares no LFS filter", async () => {
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.md text eol=lf\n");
    run("git add -A && git commit -m attrs", workDir);

    const outcome = await pushLfsObjects(safeSimpleGit(workDir), "origin", "main");
    expect(outcome.status).toBe("not-an-lfs-repo");
  });

  it("attempts the upload when a nested `.gitattributes` declares LFS", async () => {
    // Nested on purpose — the pathspec has to match `assets/.gitattributes`
    // as well as a root one, which is the shape an asset repo actually has.
    fs.mkdirSync(path.join(workDir, "assets"));
    fs.writeFileSync(
      path.join(workDir, "assets", ".gitattributes"),
      "*.png filter=lfs diff=lfs merge=lfs -text\n",
    );
    run("git add -A && git commit -m attrs", workDir);

    // `origin` is a bare local path, which is not an LFS endpoint — so the
    // transfer cannot succeed here. What is being asserted is that detection
    // said yes and `git lfs push` was reached at all; whether it then exits 0
    // (nothing to transfer) or non-zero is the network's business.
    const bare = path.join(root, "bare.git");
    fs.mkdirSync(bare);
    run("git init --bare -b main", bare);
    run(`git remote add origin ${bare}`, workDir);

    const outcome = await pushLfsObjects(safeSimpleGit(workDir), "origin", "main");
    expect(outcome.status).not.toBe("not-an-lfs-repo");
  });

  it("asks about the branch being published, not about HEAD", async () => {
    // Review finding. `GitManager.push()` takes an explicit branch, and
    // `services/git.ts`'s push route passes a caller-supplied one — so the ref
    // being published is not always the checked-out one. Detecting against
    // `HEAD` would answer "no" for a branch that DOES track LFS and skip the
    // upload, which is exactly the GH008 this module exists to prevent.
    run("git checkout -q -b assets", workDir);
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
    run("git add -A && git commit -m attrs", workDir);
    run("git checkout -q main", workDir);

    // HEAD (main) declares nothing; `assets` does.
    expect((await pushLfsObjects(safeSimpleGit(workDir), "origin", "main")).status)
      .toBe("not-an-lfs-repo");
    expect((await pushLfsObjects(safeSimpleGit(workDir), "origin", "assets")).status)
      .not.toBe("not-an-lfs-repo");
  });

  it("falls back to HEAD when the named branch does not resolve", async () => {
    // `git grep` exits 128 on a bad ref, which is "can't tell" — and a caller
    // naming a ref git cannot read must be no worse off than before.
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
    run("git add -A && git commit -m attrs", workDir);

    expect((await pushLfsObjects(safeSimpleGit(workDir), "origin", "no-such-branch")).status)
      .not.toBe("not-an-lfs-repo");
  });

  it("reports a failed upload instead of throwing", async () => {
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    run("git add -A && git commit -m attrs", workDir);
    // No such remote at all: `git lfs push` can only fail.
    const outcome = await pushLfsObjects(safeSimpleGit(workDir), "nope", "main");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.detail).not.toBe("");
  });

  it("answers 'no' rather than throwing on a repo with no commits", async () => {
    // `git grep HEAD` exits 128 on an unborn HEAD. That is "can't tell", and
    // the whole module is best-effort, so it must degrade to a no-op.
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    run("git init -b main", empty);
    const outcome = await pushLfsObjects(safeSimpleGit(empty), "origin", "main");
    expect(outcome.status).toBe("not-an-lfs-repo");
  });

  it("scopes the detection grep to the ref it is given", () => {
    expect(lfsDeclarationGrepArgs()).toContain("HEAD");
    expect(lfsDeclarationGrepArgs("refs/heads/other")).toContain("refs/heads/other");
    // The pathspec is what makes a nested declaration visible.
    expect(lfsDeclarationGrepArgs()).toContain("*.gitattributes");
  });
});

/**
 * The other half of the incident's contract: an upload that fails must NOT cost
 * the commit. `CLAUDE.md` post-turn invariant 2 — the post-turn push may not
 * gain a new way to fail — so the ref push runs regardless, and whatever the
 * server then says is classified (`services/git.ts`) rather than guessed at.
 */
describe("GitManager.push with LFS content it cannot upload", () => {
  let root: string;
  let bareDir: string;
  let workDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-pushfail-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(root, "credentials"));
    setGitIdentity("Test", "test@test.com");

    bareDir = path.join(root, "bare.git");
    workDir = path.join(root, "work");
    fs.mkdirSync(bareDir);
    fs.mkdirSync(workDir);
    run("git init --bare -b main", bareDir);

    run("git init -b main", workDir);
    run(`git remote add origin ${bareDir}`, workDir);
    fs.writeFileSync(
      path.join(workDir, ".gitattributes"),
      "*.png filter=lfs diff=lfs merge=lfs -text\n",
    );
    fs.writeFileSync(path.join(workDir, "readme.md"), "hello\n");
    run("git add -A && git commit -m init", workDir);
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("still lands the ref push, and says so in the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await new GitManager(workDir).push("origin", "main");

    // The commit reached the remote — the failure mode this fix exists to
    // prevent is the opposite one, and a swallowed upload must not create it.
    expect(run("git rev-parse refs/heads/main", bareDir).trim())
      .toBe(run("git rev-parse HEAD", workDir).trim());

    // Whichever way `git lfs push` went against a bare local path, the attempt
    // is on a surface an operator can read. Silence here is the defect.
    const lines = [...warn.mock.calls, ...log.mock.calls].map((c) => String(c[0] ?? "") + String(c[1] ?? ""));
    expect(lines.some((l) => /lfs/i.test(l))).toBe(true);
  });
});
