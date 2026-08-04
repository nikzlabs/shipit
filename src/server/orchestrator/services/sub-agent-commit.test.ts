/**
 * SHI-299 — a sub-agent consult that finishes AFTER its parent turn ended must
 * still get its work committed (and pushed) to the session branch.
 *
 * The incident these pin: a backgrounded `shipit agent run` ran for 100 minutes
 * past its parent turn's auto-commit, so the files it wrote were in no commit
 * when the PR merged, AND the dirty tree it left blocked the docs/218 pre-turn
 * auto-reset (`computeResetEligible` requires `git.isClean()`).
 *
 * These use a real git repo rather than a mocked `GitManager` on purpose: the
 * observable this feature exists for is "the branch has the work and the tree is
 * clean", which a mock cannot demonstrate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { withWorkspaceLock } from "./marketplace.js";
import { commitSubAgentWork, subAgentCommitSubject } from "./sub-agent-commit.js";

type Kind = "repo" | "sandbox" | "ops" | undefined;

function makeDeps(opts: {
  sessionDir: string;
  running?: boolean;
  kind?: Kind;
  runnerPresent?: boolean;
  withGit?: boolean;
}) {
  const emitMessage = vi.fn();
  const schedulePostTurnPush = vi.fn();
  const append = vi.fn();
  const runner = {
    sessionDir: opts.sessionDir,
    sessionId: "s1",
    running: opts.running ?? false,
    // `flushPendingTurnCommit` reads this as the default commit subject — the
    // post-turn path must NOT use it.
    turnSummary: "Whatever the last turn happened to be about",
    pendingCommitLink: null as unknown,
    emitMessage,
    schedulePostTurnPush,
  };
  const deps = {
    sessionManager: {
      get: vi.fn((id: string) =>
        id === "s1" ? { id: "s1", kind: opts.kind ?? "repo" } : undefined,
      ),
    } as never,
    runnerRegistry: {
      get: vi.fn(() => (opts.runnerPresent === false ? undefined : runner)),
    } as never,
    chatHistoryManager: { append } as never,
    ...(opts.withGit === false
      ? {}
      : { createGitManager: (dir: string) => new GitManager(dir) }),
  };
  return { deps, runner, emitMessage, schedulePostTurnPush, append };
}

describe("commitSubAgentWork", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let git: GitManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-sub-agent-commit-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
    git = new GitManager(tmpDir);
    await git.init();
    // A prior turn's commit, so the "consult wrote after the turn" state is real.
    fs.writeFileSync(path.join(tmpDir, "turn-work.txt"), "from the turn");
    await git.autoCommit("Agent turn");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("commits, pushes and leaves a clean tree when the parent turn has ended", async () => {
    fs.writeFileSync(path.join(tmpDir, "consult.md"), "codex says hello");
    const { deps, schedulePostTurnPush, append, emitMessage } = makeDeps({ sessionDir: tmpDir });

    const hash = await commitSubAgentWork(deps, "s1", { spawnId: "sp1", subAgentId: "codex" });

    expect(hash).toBeTruthy();
    const log = await git.log();
    expect(log[0].message).toBe(subAgentCommitSubject("codex"));
    // Attributable: a reader can tell this came from a consult, not a turn.
    expect(log[0].message).toContain("codex");
    expect(log[0].message).not.toContain("Whatever the last turn");
    // The docs/218 reset gate can pass again.
    expect(await git.isClean()).toBe(true);
    expect(schedulePostTurnPush).toHaveBeenCalledTimes(1);
    // The state change is visible: one persisted notice naming the commit.
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][1].text).toContain(hash!.slice(0, 8));
    expect(emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "system_notice", sessionId: "s1" }),
    );
  });

  it("does not commit while the parent turn is still running", async () => {
    fs.writeFileSync(path.join(tmpDir, "consult.md"), "codex says hello");
    const { deps, schedulePostTurnPush, append } = makeDeps({ sessionDir: tmpDir, running: true });

    const hash = await commitSubAgentWork(deps, "s1", { spawnId: "sp1", subAgentId: "codex" });

    // The ordinary post-turn commit owns this work — committing here would split
    // one turn across two commits under two different subjects.
    expect(hash).toBeNull();
    expect((await git.log()).length).toBe(2); // init + the turn's commit
    expect(await git.isClean()).toBe(false);
    expect(schedulePostTurnPush).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("commits but never pushes an ops session", async () => {
    fs.writeFileSync(path.join(tmpDir, "consult.md"), "investigation notes");
    const { deps, schedulePostTurnPush } = makeDeps({ sessionDir: tmpDir, kind: "ops" });

    expect(await commitSubAgentWork(deps, "s1", { spawnId: "sp1", subAgentId: "codex" })).toBeTruthy();
    expect(await git.isClean()).toBe(true);
    expect(schedulePostTurnPush).not.toHaveBeenCalled();
  });

  it("skips a sandbox session entirely (no root repo to commit into)", async () => {
    fs.writeFileSync(path.join(tmpDir, "consult.md"), "codex says hello");
    const { deps, schedulePostTurnPush } = makeDeps({ sessionDir: tmpDir, kind: "sandbox" });

    expect(await commitSubAgentWork(deps, "s1", { spawnId: "sp1", subAgentId: "codex" })).toBeNull();
    expect(schedulePostTurnPush).not.toHaveBeenCalled();
    expect(await git.isClean()).toBe(false);
  });

  it("is a no-op when nothing was written, when no runner is left, and with no git dep", async () => {
    // Nothing to commit — a consult that only read.
    const clean = makeDeps({ sessionDir: tmpDir });
    expect(await commitSubAgentWork(clean.deps, "s1", { spawnId: "sp1", subAgentId: "codex" })).toBeNull();
    expect(clean.schedulePostTurnPush).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(tmpDir, "consult.md"), "codex says hello");

    // Runner gone (restart / idle dispose under a long consult).
    const gone = makeDeps({ sessionDir: tmpDir, runnerPresent: false });
    expect(await commitSubAgentWork(gone.deps, "s1", { spawnId: "sp1", subAgentId: "codex" })).toBeNull();

    // Runtime without git wiring.
    const noGit = makeDeps({ sessionDir: tmpDir, withGit: false });
    expect(await commitSubAgentWork(noGit.deps, "s1", { spawnId: "sp1", subAgentId: "codex" })).toBeNull();

    expect(await git.isClean()).toBe(false);
  });

  it("refuses the commit and leaves the tree dirty on a secret finding", async () => {
    // docs/213 — the secret scan is inherited from `flushPendingTurnCommit`.
    // Assembled at runtime so THIS file's own source never carries a
    // pattern-shaped literal (it is not on the detector's path allowlist, so a
    // literal here would block ShipIt's own post-turn commit of this test).
    const keyPrefix = ["A", "K", "I", "A"].join("");
    fs.writeFileSync(path.join(tmpDir, "leak.env"), `AWS_KEY=${keyPrefix}IOSFODNN7EXAMPLE\n`);
    const { deps, schedulePostTurnPush, append } = makeDeps({ sessionDir: tmpDir });

    expect(await commitSubAgentWork(deps, "s1", { spawnId: "sp1", subAgentId: "codex" })).toBeNull();
    expect(await git.isClean()).toBe(false);
    expect(schedulePostTurnPush).not.toHaveBeenCalled();
    // The redacted warning still surfaces (emitted + persisted by the flush).
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][1].noticeLevel).toBe("warn");
  });

  it("takes the workspace lock, so a concurrent `git add -A` cannot interleave", async () => {
    fs.writeFileSync(path.join(tmpDir, "consult.md"), "codex says hello");
    const { deps } = makeDeps({ sessionDir: tmpDir });

    // docs/149 — hold the same per-workspace mutex `postTurnCommit` takes and
    // prove the commit waits behind it rather than racing it.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = withWorkspaceLock(tmpDir, () => held);

    const commit = commitSubAgentWork(deps, "s1", { spawnId: "sp1", subAgentId: "codex" });
    // Give the commit a chance to (wrongly) proceed.
    await new Promise((r) => setTimeout(r, 20));
    expect(await git.isClean()).toBe(false);

    release();
    await holder;
    expect(await commit).toBeTruthy();
    expect(await git.isClean()).toBe(true);
  });
});
