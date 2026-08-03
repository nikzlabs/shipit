/**
 * SHI-277 — `shipit branch reset-to-base --force`, the break-glass for a branch
 * whose work shipped under a DIFFERENT commit.
 *
 * These tests build the stranded state for real — a bare "remote", a multi-commit
 * feature branch, a SQUASH merge into `main`, then a cherry-pick of the branch's
 * tip — and drive the real `GitManager` against it. That shape matters: it is
 * exactly what ShipIt's own merge flow produces, and it is what makes
 * `HEAD === mergedHeadSha` unsatisfiable forever. Without an override the session
 * can never open another pull request.
 *
 * One test here exists purely to pin a falsified claim. An earlier revision of
 * this fix told the agent to `git rebase origin/<base>` instead, on the theory
 * that already-shipped patches drop out. They do not drop out after a squash: the
 * base gains the branch as ONE commit holding the FINAL state, while the branch's
 * FIRST commit adds the same paths in their INITIAL state, so the replay is an
 * add/add conflict. That was reproduced by hand on the branch this bug stranded
 * (`shipit/shi-267-…`) before it was reproduced here. If someone re-adds the
 * rebase advice, `rebase onto the squashed base conflicts` fails.
 */
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
  /** The branch tip ShipIt recorded at merge time. */
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

    // A multi-commit feature branch. The FIRST commit adds `feature.ts` in its
    // initial state; the LAST rewrites it — the ingredients of the add/add
    // conflict a post-squash rebase hits.
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

    // SQUASH-merge the branch into main — ShipIt's own flow, and the reason the
    // branch's individual commits are not in the base's history.
    inSession("checkout", "-q", "main");
    inSession("merge", "-q", "--squash", BRANCH);
    inSession("commit", "-qm", "feature (#1890)");
    inSession("push", "-q", "origin", "main");

    // Back on the branch, exactly as the stranded session was left.
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

  /**
   * The stranding itself: one commit past the recorded merged tip, with that
   * commit's CONTENT already in the base via a cherry-pick. This is the exact
   * state PR #1890 left behind.
   */
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
    expect(outcome.reason).toMatch(/not on the merged pull request/);
    // The refusal must point at the override, or it reads as a dead end and the
    // agent reaches for `git reset --hard` instead.
    expect(outcome.reason).toMatch(/--force/);
    // Nothing moved.
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
    // The remote branch was healed too — otherwise every later plain auto-push
    // is a silently-dropped non-fast-forward and the next PR never updates.
    expect(
      execFileSync("git", ["rev-parse", `refs/heads/${BRANCH}`], { cwd: remoteDir, encoding: "utf8" }).trim(),
    ).toBe(baseTip);
    expect(inSession("status", "--porcelain")).toBe("");
  });

  /**
   * The one thing --force does NOT override. A discarded commit is still in the
   * reflog; a discarded uncommitted edit is gone. This is the refusal that fired
   * first in the production incident, and it fired correctly.
   */
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

  /**
   * The falsified claim, pinned. If this ever passes cleanly, a squash stopped
   * behaving the way it does today and the rebase advice could be revisited —
   * until then, the refusal copy must not send anyone here.
   */
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
    // Left mid-rebase, which is itself a state the reset gate refuses over.
    expect(fs.existsSync(path.join(sessionDir, ".git", "rebase-merge"))
      || fs.existsSync(path.join(sessionDir, ".git", "rebase-apply"))).toBe(true);
    execFileSync("git", ["rebase", "--abort"], { cwd: sessionDir, stdio: "pipe" });
  });

  /**
   * `--force` is not a blanket bypass of the command: an unchanged, still-at-the
   * -merged-tip branch takes the ordinary path and the SHA clause is simply not
   * the thing standing in its way.
   */
  it("is a no-op distinction on a branch that is already at the base", async () => {
    inSession("reset", "--hard", "origin/main");
    const outcome = await resetBranchToBaseExplicit(makeDeps(makeSession()), "s1", sessionDir, {
      force: { reason: "recovering a stranded branch" },
    });
    expect(outcome.outcome).toBe("already-at-base");
    expect(outcome.forced).toBeUndefined();
  });
});
