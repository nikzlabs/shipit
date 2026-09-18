import { describe, it, expect, vi } from "vitest";
import { generatePrDescription, quickCreatePr } from "./github.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";

const REMOTE = "https://github.com/o/r.git";

function makeGit(over: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
  return {
    getRemotes: vi.fn(async () => [{ name: "origin", url: REMOTE }]),
    addRemote: vi.fn(async () => {}),
    getCurrentBranch: vi.fn(async () => "shipit/x"),
    push: vi.fn(async () => "pushed"),
    forcePush: vi.fn(async () => "force pushed"),
    listRemoteBranches: vi.fn(async () => ["main", "release/v2"]),
    getDefaultBranch: vi.fn(async () => "main"),
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

describe("quickCreatePr — created vs discovered (docs/287)", () => {
  it("reports `alreadyExisted: false` and the repository when it creates the PR", async () => {
    const github = makeGitHub();

    const result = await quickCreatePr(
      makeGit(), github, chatHistory, generateText, "s1", "Title", "/ws/s1", REMOTE,
    );

    expect(github.createPullRequest).toHaveBeenCalled();
    expect(result.alreadyExisted).toBe(false);
    expect(result).toMatchObject({ owner: "o", repo: "r" });
  });

  it("reports `alreadyExisted: true` for a pull request it merely found", async () => {
    const github = makeGitHub();
    (github.findPullRequest as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 41,
      url: "https://github.com/o/r/pull/41",
      title: "Opened by someone else",
      body: "",
      base: "main",
    });

    const result = await quickCreatePr(
      makeGit(), github, chatHistory, generateText, "s1", "Title", "/ws/s1", REMOTE,
    );

    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(result.number).toBe(41);
    expect(result.alreadyExisted).toBe(true);
  });
});

describe("quickCreatePr description fallback (docs/252 req 9)", () => {
  it("falls back to the generic description when generation returns nothing", async () => {
    const git = makeGit();
    const github = makeGitHub();

    await quickCreatePr(
      git, github, chatHistory, async () => "",
      "s1", "Title", "/ws/s1", REMOTE,
    );

    const body = (github.createPullRequest as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0][0].body as string;
    expect(body).toContain("## Summary");
    expect(body).toContain("c1");
  });

  it("falls back to the generic description when generation throws", async () => {
    const git = makeGit();
    const github = makeGitHub();

    await quickCreatePr(
      git, github, chatHistory, async () => { throw new Error("boom"); },
      "s1", "Title", "/ws/s1", REMOTE,
    );

    const body = (github.createPullRequest as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0][0].body as string;
    expect(body).toContain("## Summary");
  });

  it("passes the session id and purpose so the generation is routed and attributed", async () => {
    const git = makeGit();
    const github = makeGitHub();
    const generate = vi.fn(async () => "## Summary\nbody");

    await quickCreatePr(
      git, github, chatHistory, generate,
      "s1", "Title", "/ws/s1", REMOTE,
    );

    expect(generate).toHaveBeenCalledWith(
      expect.any(String),
      "/ws/s1",
      { sessionId: "s1", purpose: "pr-description" },
    );
  });
});

describe("generatePrDescription fallback (docs/252 req 9)", () => {
  it("returns the generic description when generation returns nothing", async () => {
    const git = makeGit();
    const { description } = await generatePrDescription(git, async () => "  ", "/ws/s1", "s1");
    expect(description).toContain("## Summary");
    expect(description).toContain("c1");
  });

  it("returns nothing at all when the branch has no commits to describe", async () => {
    const git = makeGit({ log: vi.fn(async () => []) });
    const { description } = await generatePrDescription(git, async () => "", "/ws/s1", "s1");
    expect(description).toBe("");
  });

  it("forwards the session id and purpose so the generation is routed and attributed", async () => {
    const git = makeGit();
    const generate = vi.fn(async () => "## Summary\nbody");
    await generatePrDescription(git, generate, "/ws/s1", "s1");
    expect(generate).toHaveBeenCalledWith(
      expect.any(String),
      "/ws/s1",
      { sessionId: "s1", purpose: "pr-description" },
    );
  });
});
