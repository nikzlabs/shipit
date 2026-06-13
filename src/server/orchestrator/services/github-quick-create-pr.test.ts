import { describe, it, expect, vi } from "vitest";
import { quickCreatePr } from "./github.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";

/**
 * docs/202 — `quickCreatePr` re-arm overrides: when re-arming a merged-then-
 * rebased session, the new PR must target the prior PR's base (not auto-detected
 * main/master) and push with `--force-with-lease` (the old remote branch often
 * survives and the rebased branch has diverged). Gated on the re-arm options so
 * a normal create is never force-pushed.
 */

const REMOTE = "https://github.com/o/r.git";

function makeGit(over: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
  return {
    getRemotes: vi.fn(async () => [{ name: "origin", url: REMOTE }]),
    addRemote: vi.fn(async () => {}),
    getCurrentBranch: vi.fn(async () => "shipit/x"),
    push: vi.fn(async () => "pushed"),
    forcePush: vi.fn(async () => "force pushed"),
    listRemoteBranches: vi.fn(async () => ["main", "release/v2"]),
    log: vi.fn(async () => [{ message: "c1", hash: "h", date: "", author: "", refs: [] }]),
    diffSummary: vi.fn(async () => []),
    diffStatVsBranch: vi.fn(async () => ({ insertions: 3, deletions: 1 })),
    ...over,
  } as unknown as GitManager;
}

function makeGitHub(): GitHubAuthManager {
  return {
    authenticated: true,
    findPullRequest: vi.fn(async () => null),
    createPullRequest: vi.fn(async () => ({
      success: true,
      url: "https://github.com/o/r/pull/99",
      number: 99,
    })),
  } as unknown as GitHubAuthManager;
}

const chatHistory = { load: () => [] } as unknown as ChatHistoryManager;
const generateText = async () => "## Summary\nbody";

describe("quickCreatePr (docs/202 re-arm overrides)", () => {
  it("targets the prior PR's base and force-pushes for a re-armed branch", async () => {
    const git = makeGit();
    const github = makeGitHub();

    const result = await quickCreatePr(
      git, github, chatHistory, generateText,
      "s1", "Title", "/ws/s1", REMOTE,
      { baseBranch: "release/v2", forceWithLease: true },
    );

    expect(git.forcePush).toHaveBeenCalledWith("origin", "shipit/x");
    expect(git.push).not.toHaveBeenCalled();
    // The base is the prior PR's base, not auto-detected main.
    expect(git.listRemoteBranches).not.toHaveBeenCalled();
    expect(github.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ base: "release/v2", head: "shipit/x" }),
    );
    expect(result.baseBranch).toBe("release/v2");
    expect(result.number).toBe(99);
  });

  it("uses a plain push + auto-detected base for a normal (non-re-armed) create", async () => {
    const git = makeGit();
    const github = makeGitHub();

    const result = await quickCreatePr(
      git, github, chatHistory, generateText,
      "s1", "Title", "/ws/s1", REMOTE,
    );

    expect(git.push).toHaveBeenCalledWith("origin", "shipit/x");
    expect(git.forcePush).not.toHaveBeenCalled();
    expect(github.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ base: "main" }),
    );
    expect(result.baseBranch).toBe("main");
  });
});
