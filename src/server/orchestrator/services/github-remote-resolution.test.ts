import { describe, it, expect, vi } from "vitest";
import { listPullRequests } from "./github.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";

const SHIPIT_REPO = "https://github.com/nikzlabs/shipit.git";
const OTHER_REPO = "https://github.com/o/other.git";
const BARE_CACHE_PATH = "/var/lib/shipit/repo-cache/9f2c1a";

function makeGit(remotes: { name: string; url: string }[]) {
  const addRemote = vi.fn(async () => {});
  const git = {
    getRemotes: vi.fn(async () => remotes),
    addRemote,
  } as unknown as GitManager;
  return { git, addRemote };
}

function makeGitHub(): GitHubAuthManager {
  return {
    authenticated: true,
    listPullRequests: vi.fn(async () => ({ ok: true as const, prs: [] })),
  } as unknown as GitHubAuthManager;
}

describe("resolveGitHubRemote — reads must not write git config", () => {
  it("does not create an origin in a workspace that has none", async () => {
    const { git, addRemote } = makeGit([]);
    await listPullRequests(git, makeGitHub(), { remoteUrl: SHIPIT_REPO });
    expect(addRemote).not.toHaveBeenCalled();
  });

  it("still resolves owner/repo from the explicit remoteUrl", async () => {
    const { git } = makeGit([]);
    const gh = makeGitHub();
    await listPullRequests(git, gh, { remoteUrl: SHIPIT_REPO });
    expect(gh.listPullRequests).toHaveBeenCalledWith("nikzlabs", "shipit", "open", undefined);
  });

  it("does not repoint an existing GitHub origin at a --repo target", async () => {
    const { git, addRemote } = makeGit([{ name: "origin", url: SHIPIT_REPO }]);
    await listPullRequests(git, makeGitHub(), { remoteUrl: OTHER_REPO });
    expect(addRemote).not.toHaveBeenCalled();
  });

  it("repairs an origin still pointing at the bare cache path", async () => {
    const { git, addRemote } = makeGit([{ name: "origin", url: BARE_CACHE_PATH }]);
    await listPullRequests(git, makeGitHub(), { remoteUrl: SHIPIT_REPO });
    expect(addRemote).toHaveBeenCalledWith("origin", SHIPIT_REPO);
  });

  it("leaves a matching origin alone", async () => {
    const { git, addRemote } = makeGit([{ name: "origin", url: SHIPIT_REPO }]);
    await listPullRequests(git, makeGitHub(), { remoteUrl: SHIPIT_REPO });
    expect(addRemote).not.toHaveBeenCalled();
  });

  it("falls back to reading the clone's own origin when no remoteUrl is given", async () => {
    const { git, addRemote } = makeGit([{ name: "origin", url: OTHER_REPO }]);
    const gh = makeGitHub();
    await listPullRequests(git, gh, {});
    expect(gh.listPullRequests).toHaveBeenCalledWith("o", "other", "open", undefined);
    expect(addRemote).not.toHaveBeenCalled();
  });

  it("errors, rather than inventing a remote, when there is nothing to resolve", async () => {
    const { git } = makeGit([]);
    await expect(listPullRequests(git, makeGitHub(), {})).rejects.toThrow(
      /No 'origin' remote configured/,
    );
  });
});
