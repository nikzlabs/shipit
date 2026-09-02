/**
 * `resolveGitHubRemote` must not give a workspace an `origin` it didn't have.
 *
 * It sits on the read path of every brokered `gh` operation, and `remoteUrl` is
 * routinely NOT the session's own repo — `resolvePrTarget` maps an explicit
 * `gh --repo owner/name` straight through to it. It used to `addRemote("origin",
 * remoteUrl)` on any mismatch, so a plain `gh pr list --repo nikzlabs/shipit`
 * from an ops session wired the real ShipIt repo into that session's throwaway
 * workspace as `origin`. The next post-turn auto-push then sailed past
 * `pushToOrigin`'s no-origin guard and tried to push the ops workspace at it.
 *
 * The one legitimate repair — an origin still pointing at the bare cache's
 * filesystem path, from `git clone --local` — is preserved.
 */

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
    // `{ ok: true, prs: [] }` is the shape that means "no pull requests"; a
    // bare `[]` would now read as a failed request and make the service throw.
    listPullRequests: vi.fn(async () => ({ ok: true as const, prs: [] })),
  } as unknown as GitHubAuthManager;
}

describe("resolveGitHubRemote — reads must not write git config", () => {
  it("does not create an origin in a workspace that has none", async () => {
    // The ops-session bug: `gh pr list --repo nikzlabs/shipit` in a workspace
    // that is a bare `git init` with no remote at all.
    const { git, addRemote } = makeGit([]);
    await listPullRequests(git, makeGitHub(), { remoteUrl: SHIPIT_REPO });
    expect(addRemote).not.toHaveBeenCalled();
  });

  it("still resolves owner/repo from the explicit remoteUrl", async () => {
    const { git } = makeGit([]);
    const gh = makeGitHub();
    await listPullRequests(git, gh, { remoteUrl: SHIPIT_REPO });
    // The 4th argument is `-L/--limit`; undefined means "the read's own default".
    expect(gh.listPullRequests).toHaveBeenCalledWith("nikzlabs", "shipit", "open", undefined);
  });

  it("does not repoint an existing GitHub origin at a --repo target", async () => {
    // A repo-bound session running `gh pr list --repo o/other` must not have its
    // own origin swapped — the next auto-push would go to the wrong repo.
    const { git, addRemote } = makeGit([{ name: "origin", url: SHIPIT_REPO }]);
    await listPullRequests(git, makeGitHub(), { remoteUrl: OTHER_REPO });
    expect(addRemote).not.toHaveBeenCalled();
  });

  it("repairs an origin still pointing at the bare cache path", async () => {
    // The one case the repair exists for: `clone --local` leaves origin as a
    // filesystem path, which is not a push target, so rewriting it loses nothing.
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
