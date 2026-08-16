/**
 * docs/266 — the uid decision for orchestrator-side git.
 *
 * These states cannot be produced for real in a session container: it has no
 * root, and `unshare -r` is refused ("Operation not permitted"), so a
 * genuinely foreign-owned directory is not creatable either. That is exactly
 * why {@link resolveGitTreeUid} takes its `getuid`/`statOwner` as injected
 * dependencies — the decision is pure and testable even where the environment
 * is not.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  resolveGitTreeUid,
  gitSpawnOverridesForTree,
  unprivilegedGitConfigPath,
  UNPRIVILEGED_GITCONFIG_ENV,
  type GitTreeUidDeps,
} from "./git-tree-uid.js";

/** Deps for "we are root, and the tree belongs to `owner`". */
function asRoot(owner: { uid: number; gid: number } | null): GitTreeUidDeps {
  return { getuid: () => 0, statOwner: () => owner };
}

describe("resolveGitTreeUid", () => {
  it("drops to the tree's owner when root and the tree is not root-owned", () => {
    expect(resolveGitTreeUid("/workspace/s1", asRoot({ uid: 1000, gid: 1000 })))
      .toEqual({ uid: 1000, gid: 1000 });
  });

  it("does not drop when the process is not root", () => {
    // The session worker container, local mode, and every test run land here.
    // A non-root process cannot setuid at all, so asking would be an EPERM at
    // spawn rather than a security improvement.
    const deps: GitTreeUidDeps = { getuid: () => 1000, statOwner: () => ({ uid: 1000, gid: 1000 }) };
    expect(resolveGitTreeUid("/workspace/s1", deps)).toBeNull();
  });

  it("does not drop for a root-owned tree", () => {
    // The shared bare cache and /opt/shipit. Nothing untrusted can write them,
    // and dropping would break ShipIt's own writes for no gain.
    expect(resolveGitTreeUid("/state/repos/abc", asRoot({ uid: 0, gid: 0 }))).toBeNull();
  });

  it("does not drop when the path cannot be stat'd", () => {
    expect(resolveGitTreeUid("/gone", asRoot(null))).toBeNull();
  });

  it("does not drop without a directory", () => {
    expect(resolveGitTreeUid(undefined, asRoot({ uid: 1000, gid: 1000 }))).toBeNull();
  });

  it("carries the tree's gid, not a guess derived from the uid", () => {
    // A workspace chowned `1000:2000` must spawn git with gid 2000, or writes
    // into group-owned directories fail in a way that looks like corruption.
    expect(resolveGitTreeUid("/workspace/s1", asRoot({ uid: 1000, gid: 2000 })))
      .toEqual({ uid: 1000, gid: 2000 });
  });
});

describe("unprivilegedGitConfigPath", () => {
  const original = process.env[UNPRIVILEGED_GITCONFIG_ENV];
  afterEach(() => {
    process.env[UNPRIVILEGED_GITCONFIG_ENV] = original ?? "";
  });

  it("is null when the orchestrator has not written one (unset or cleared)", () => {
    process.env[UNPRIVILEGED_GITCONFIG_ENV] = "";
    expect(unprivilegedGitConfigPath()).toBeNull();
  });

  it("treats a blank value as unset rather than as a path", () => {
    process.env[UNPRIVILEGED_GITCONFIG_ENV] = "   ";
    expect(unprivilegedGitConfigPath()).toBeNull();
  });

  it("returns the configured path", () => {
    process.env[UNPRIVILEGED_GITCONFIG_ENV] = "/credentials/.gitconfig-unprivileged";
    expect(unprivilegedGitConfigPath()).toBe("/credentials/.gitconfig-unprivileged");
  });
});

describe("gitSpawnOverridesForTree", () => {
  it("is empty when no drop applies, so call sites can spread unconditionally", () => {
    // The point of returning `{}` rather than undefined: every raw git spawn
    // spreads this the same way whether or not the deployment drops uid.
    expect(gitSpawnOverridesForTree("/opt/shipit")).toEqual({});
  });
});
