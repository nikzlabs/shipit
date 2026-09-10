import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resetBranchToBaseExplicit } from "./pre-turn-reset.js";
import { GitManager } from "../../shared/git.js";
import type { SessionInfo } from "../../shared/types.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";

vi.mock("../session-worker-uid.js", () => ({
  handWorkspaceBackToWorker: vi.fn(),
  chownWorkspaceGitToSessionWorker: vi.fn(),
}));

const BRANCH = "shipit/feature-abc";

describe("reset-to-base --force on a squash-merged, cherry-picked branch", () => {
  let root: string;
  let remoteDir: string;
  let sessionDir: string;
  let mergedHeadSha: string;

  const inSession = (...args: string[]) =>
    execFileSync("git", args, { cwd: sessionDir, encoding: "utf8", stdio: "pipe" }).trim();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shi277-"));
    remoteDir = path.join(root, "remote.git");
    sessionDir = path.join(root, "session");

    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remoteDir], { stdio: "pipe" });
    execFileSync("git", ["clone", "-q", remoteDir, sessionDir], { stdio: "pipe" });
    inSession("config", "user.email", "test@example.com");
    inSession("config", "user.name", "Test");

    fs.writeFileSync(path.join(sessionDir, "README.md"), "base\n");
    inSession("add", "-A");
    inSession("commit", "-qm", "initial");
    inSession("push", "-q", "origin", "main");

    inSession("checkout", "-q", "-b", BRANCH);
    fs.writeFileSync(path.join(sessionDir, "feature.ts"), "export const v = 1;\n");
    inSession("add", "-A");
    inSession("commit", "-qm", "feature: first cut");
    fs.writeFileSync(path.join(sessionDir, "feature.ts"), "export const v = 2;\n");
    inSession("add", "-A");
    inSession("commit", "-qm", "feature: review fixes");
    fs.writeFileSync(path.join(sessionDir, "feature.ts"), "export const v = 3;\n");
    inSession("add", "-A");
    inSession("commit", "-qm", "feature: blocker fixes");
    inSession("push", "-q", "-u", "origin", BRANCH);
    mergedHeadSha = inSession("rev-parse", "HEAD");

    inSession("checkout", "-q", "main");
    inSession("merge", "-q", "--squash", BRANCH);
    inSession("commit", "-qm", "feature (#1890)");
    inSession("push", "-q", "origin", "main");

    inSession("checkout", "-q", BRANCH);
    inSession("fetch", "-q", "origin");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
    return {
      id: "s1",
      title: "Feature ABC",
      createdAt: "2026-08-01T00:00:00.000Z",
      lastUsedAt: "2026-08-01T00:00:00.000Z",
      remoteUrl: remoteDir,
      branch: BRANCH,
      mergedAt: "2026-08-03 13:23:44",
      mergedHeadSha,
      ...over,
    };
  }

  function makePrStatus(): PrStatusSummary {
    return {
      sessionId: "s1",
      prNumber: 1890,
      prUrl: "https://github.com/o/r/pull/1890",
      prTitle: "Feature ABC",
      prBody: "",
      prState: "merged",
      baseBranch: "main",
      headBranch: BRANCH,
      insertions: 1,
      deletions: 0,
      checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: "unknown",
      reviewDecision: "none",
      autoMergeEnabled: false,
    };
  }

  function makeDeps(session: SessionInfo) {
    return {
      getSession: () => session,
      getPrStatus: () => makePrStatus(),
      createGitManager: (dir: string) => new GitManager(dir),
    };
  }

  function strandViaCherryPick(): void {
    fs.writeFileSync(path.join(sessionDir, "feature.ts"), "export const v = 4;\n");
    inSession("add", "-A");
    inSession("commit", "-qm", "the blocker fixes the squash missed");
    const tip = inSession("rev-parse", "HEAD");
    inSession("push", "-q", "origin", BRANCH);
    inSession("checkout", "-q", "main");
    inSession("cherry-pick", tip);
    inSession("push", "-q", "origin", "main");
    inSession("checkout", "-q", BRANCH);
    inSession("fetch", "-q", "origin");
  }

  it("refuses without --force, because HEAD can never equal the merged head again", async () => {
    strandViaCherryPick();
    const session = makeSession();

    const outcome = await resetBranchToBaseExplicit(makeDeps(session), "s1", sessionDir);

    expect(outcome.outcome).toBe("refused");
    expect(outcome.reason).toMatch(/moved since the merge/);
    expect(outcome.reason).toMatch(/not contained in origin\/main/);
    expect(outcome.reason).toMatch(/--force/);
    expect(inSession("rev-parse", "HEAD")).not.toBe(inSession("rev-parse", "origin/main"));
  });

  it("resets with --force, and force-updates the remote branch to match", async () => {
    strandViaCherryPick();
    const session = makeSession();
    const baseTip = inSession("rev-parse", "origin/main");

    const outcome = await resetBranchToBaseExplicit(makeDeps(session), "s1", sessionDir, {
      force: { reason: "content shipped via cherry-pick b7222c34; branch is stranded" },
    });

    expect(outcome.outcome).toBe("reset");
    expect(outcome.forced).toBe(true);
    expect(outcome.forceReason).toMatch(/cherry-pick/);
    expect(outcome.base).toBe("main");
    expect(inSession("rev-parse", "HEAD")).toBe(baseTip);
    expect(
      execFileSync("git", ["rev-parse", `refs/heads/${BRANCH}`], { cwd: remoteDir, encoding: "utf8" }).trim(),
    ).toBe(baseTip);
    expect(inSession("status", "--porcelain")).toBe("");
  });

  it("still refuses under --force when the working tree is dirty", async () => {
    strandViaCherryPick();
    fs.writeFileSync(path.join(sessionDir, "feature.ts"), "uncommitted work nobody can get back\n");
    const session = makeSession();

    const outcome = await resetBranchToBaseExplicit(makeDeps(session), "s1", sessionDir, {
      force: { reason: "recovering a stranded branch" },
    });

    expect(outcome.outcome).toBe("refused");
    expect(outcome.reason).toMatch(/uncommitted changes/);
    expect(fs.readFileSync(path.join(sessionDir, "feature.ts"), "utf8")).toBe(
      "uncommitted work nobody can get back\n",
    );
  });

  it("still refuses under --force on a detached HEAD or a half-finished rebase", async () => {
    strandViaCherryPick();
    inSession("checkout", "-q", "--detach", "HEAD");

    const detached = await resetBranchToBaseExplicit(makeDeps(makeSession()), "s1", sessionDir, {
      force: { reason: "recovering a stranded branch" },
    });
    expect(detached.outcome).toBe("refused");
    expect(detached.reason).toMatch(/detached/);
  });

  it("rebase onto the squashed base conflicts, so it is NOT a recovery path", () => {
    strandViaCherryPick();
    expect(inSession("status", "--porcelain")).toBe("");

    let conflicted = false;
    try {
      execFileSync("git", ["rebase", "origin/main"], { cwd: sessionDir, stdio: "pipe" });
    } catch {
      conflicted = true;
    }
    expect(conflicted).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, ".git", "rebase-merge"))
      || fs.existsSync(path.join(sessionDir, ".git", "rebase-apply"))).toBe(true);
    execFileSync("git", ["rebase", "--abort"], { cwd: sessionDir, stdio: "pipe" });
  });

  describe("a re-armed branch sitting behind an advanced base", () => {
    function advanceBaseBeyondBranch(): void {
      inSession("checkout", "-q", "main");
      fs.writeFileSync(path.join(sessionDir, "OTHER.md"), "someone else's merged PR\n");
      inSession("add", "-A");
      inSession("commit", "-qm", "another PR (#2146)");
      inSession("push", "-q", "origin", "main");
      inSession("checkout", "-q", BRANCH);
      inSession("reset", "--hard", "origin/main~1");
      inSession("fetch", "-q", "origin");
    }

    function reArmedSession(): SessionInfo {
      const s = makeSession();
      delete s.mergedAt;
      delete s.mergedHeadSha;
      s.previousMergedPr = {
        number: 2145,
        url: "https://github.com/o/r/pull/2145",
        title: "Feature ABC",
        baseBranch: "main",
      };
      return s;
    }

    it("resets without --force, because HEAD is contained in origin/main", async () => {
      advanceBaseBeyondBranch();
      const baseTip = inSession("rev-parse", "origin/main");
      expect(inSession("rev-parse", "HEAD")).not.toBe(baseTip);
      expect(inSession("status", "--porcelain")).toBe("");

      const outcome = await resetBranchToBaseExplicit(
        { ...makeDeps(reArmedSession()), getPrStatus: () => null }, "s1", sessionDir,
      );

      expect(outcome.outcome).toBe("reset");
      expect(outcome.forced).toBeUndefined();
      expect(outcome.base).toBe("main");
      expect(inSession("rev-parse", "HEAD")).toBe(baseTip);
    });

    it("still refuses once that same branch gains a commit of its own", async () => {
      advanceBaseBeyondBranch();
      fs.writeFileSync(path.join(sessionDir, "unshipped.ts"), "export const x = 1;\n");
      inSession("add", "-A");
      inSession("commit", "-qm", "work nobody has merged");
      const head = inSession("rev-parse", "HEAD");

      const outcome = await resetBranchToBaseExplicit(
        { ...makeDeps(reArmedSession()), getPrStatus: () => null }, "s1", sessionDir,
      );

      expect(outcome.outcome).toBe("refused");
      expect(outcome.reason).toMatch(/no record of the commit GitHub merged/);
      expect(inSession("rev-parse", "HEAD")).toBe(head);
    });

    it("passes on the breadcrumb's anchor when the branch is untouched since the merge", async () => {
      const session = reArmedSession();
      session.previousMergedPr = { ...session.previousMergedPr!, mergedHeadSha };
      expect(inSession("rev-parse", "HEAD")).toBe(mergedHeadSha);

      const outcome = await resetBranchToBaseExplicit(
        { ...makeDeps(session), getPrStatus: () => null }, "s1", sessionDir,
      );

      expect(outcome.outcome).toBe("reset");
      expect(outcome.forced).toBeUndefined();
      expect(inSession("rev-parse", "HEAD")).toBe(inSession("rev-parse", "origin/main"));
    });
  });

  it("is a no-op distinction on a branch that is already at the base", async () => {
    inSession("reset", "--hard", "origin/main");
    const outcome = await resetBranchToBaseExplicit(makeDeps(makeSession()), "s1", sessionDir, {
      force: { reason: "recovering a stranded branch" },
    });
    expect(outcome.outcome).toBe("already-at-base");
    expect(outcome.forced).toBeUndefined();
  });
});
