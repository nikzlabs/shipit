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
    expect(log[0].message).toContain("codex");
    expect(log[0].message).not.toContain("Whatever the last turn");
    expect(await git.isClean()).toBe(true);
    expect(schedulePostTurnPush).toHaveBeenCalledTimes(1);
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

    expect(hash).toBeNull();
    expect((await git.log()).length).toBe(2);
    expect(await git.isClean()).toBe(false);
    expect(schedulePostTurnPush).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  for (const kind of ["ops", "sandbox"] as const) {
    it(`skips a ${kind} session entirely — no commit, no push, tree left dirty`, async () => {
      fs.writeFileSync(path.join(tmpDir, "consult.md"), "investigation notes");
      const { deps, schedulePostTurnPush, append } = makeDeps({ sessionDir: tmpDir, kind });

      expect(await commitSubAgentWork(deps, "s1", { spawnId: "sp1", subAgentId: "codex" })).toBeNull();
      expect(schedulePostTurnPush).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(await git.isClean()).toBe(false);
    });
  }

  it("is a no-op when nothing was written, when no runner is left, and with no git dep", async () => {
    const clean = makeDeps({ sessionDir: tmpDir });
    expect(await commitSubAgentWork(clean.deps, "s1", { spawnId: "sp1", subAgentId: "codex" })).toBeNull();
    expect(clean.schedulePostTurnPush).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(tmpDir, "consult.md"), "codex says hello");

    const gone = makeDeps({ sessionDir: tmpDir, runnerPresent: false });
    expect(await commitSubAgentWork(gone.deps, "s1", { spawnId: "sp1", subAgentId: "codex" })).toBeNull();

    const noGit = makeDeps({ sessionDir: tmpDir, withGit: false });
    expect(await commitSubAgentWork(noGit.deps, "s1", { spawnId: "sp1", subAgentId: "codex" })).toBeNull();

    expect(await git.isClean()).toBe(false);
  });

  it("refuses the commit and leaves the tree dirty on a secret finding", async () => {
    // Assemble the fake key at runtime so this test source does not trip the scanner.
    const keyPrefix = ["A", "K", "I", "A"].join("");
    fs.writeFileSync(path.join(tmpDir, "leak.env"), `AWS_KEY=${keyPrefix}IOSFODNN7EXAMPLE\n`);
    const { deps, schedulePostTurnPush, append } = makeDeps({ sessionDir: tmpDir });

    expect(await commitSubAgentWork(deps, "s1", { spawnId: "sp1", subAgentId: "codex" })).toBeNull();
    expect(await git.isClean()).toBe(false);
    expect(schedulePostTurnPush).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][1].noticeLevel).toBe("warn");
  });

  it("takes the workspace lock, so a concurrent `git add -A` cannot interleave", async () => {
    fs.writeFileSync(path.join(tmpDir, "consult.md"), "codex says hello");
    const { deps } = makeDeps({ sessionDir: tmpDir });

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = withWorkspaceLock(tmpDir, () => held);

    const commit = commitSubAgentWork(deps, "s1", { spawnId: "sp1", subAgentId: "codex" });
    await new Promise((r) => setTimeout(r, 20));
    expect(await git.isClean()).toBe(false);

    release();
    await holder;
    expect(await commit).toBeTruthy();
    expect(await git.isClean()).toBe(true);
  });
});
