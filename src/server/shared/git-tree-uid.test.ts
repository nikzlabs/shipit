import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveGitTreeUid,
  gitSpawnOverridesForTree,
  type GitTreeUidDeps,
} from "./git-tree-uid.js";
import { configureSessionIdentityRoots } from "./session-identity.js";

afterEach(() => configureSessionIdentityRoots(null));

function asRoot(owner: { uid: number; gid: number } | null): GitTreeUidDeps {
  return { getuid: () => 0, statOwner: () => owner };
}

describe("resolveGitTreeUid", () => {
  it("drops to the tree's owner when root and the tree is not root-owned", () => {
    expect(resolveGitTreeUid("/workspace/s1", asRoot({ uid: 1000, gid: 1000 })))
      .toEqual({ uid: 1000, gid: 1000 });
  });

  it("does not drop when the process is not root", () => {
    const deps: GitTreeUidDeps = { getuid: () => 1000, statOwner: () => ({ uid: 1000, gid: 1000 }) };
    expect(resolveGitTreeUid("/workspace/s1", deps)).toBeNull();
  });

  it("does not drop for a root-owned tree", () => {
    expect(resolveGitTreeUid("/state/repos/abc", asRoot({ uid: 0, gid: 0 }))).toBeNull();
  });

  it("does not drop when the path cannot be stat'd", () => {
    expect(resolveGitTreeUid("/gone", asRoot(null))).toBeNull();
  });

  it("does not drop without a directory", () => {
    expect(resolveGitTreeUid(undefined, asRoot({ uid: 1000, gid: 1000 }))).toBeNull();
  });

  it("carries the tree's gid, not a guess derived from the uid", () => {
    expect(resolveGitTreeUid("/workspace/s1", asRoot({ uid: 1000, gid: 2000 })))
      .toEqual({ uid: 1000, gid: 2000 });
  });
});

describe("resolveGitTreeUid under per-session identities (docs/270)", () => {
  it("takes the identity from the session directory, not from the tree", () => {
    configureSessionIdentityRoots({ sessionsRoot: "/workspace/sessions" });
    const treeSaysSomeoneElse = asRoot({ uid: 2_000_999, gid: 1000 });
    // No session directory exists; the tree cannot supply the missing identity.
    expect(resolveGitTreeUid("/workspace/sessions/s1/workspace", treeSaysSomeoneElse))
      .toBeNull();
  });

  it("still uses the tree for a path that belongs to no session", () => {
    configureSessionIdentityRoots({ sessionsRoot: "/workspace/sessions" });
    expect(resolveGitTreeUid("/workspace/repo-cache/abc", asRoot({ uid: 0, gid: 0 })))
      .toBeNull();
    expect(resolveGitTreeUid("/workspace/repo-cache/abc", asRoot({ uid: 1000, gid: 1000 })))
      .toEqual({ uid: 1000, gid: 1000 });
  });

  it("is unchanged when the roots are unconfigured", () => {
    expect(resolveGitTreeUid("/workspace/sessions/s1/workspace", asRoot({ uid: 1000, gid: 1000 })))
      .toEqual({ uid: 1000, gid: 1000 });
  });
});

describe("the foreign-tree diagnostic (docs/272-shared-cache-ownership)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("says nothing for a session workspace, however the tree is owned", () => {
    const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-git-tree-uid-"));
    const sessionDir = path.join(sessionsRoot, "s1");
    fs.mkdirSync(sessionDir);
    configureSessionIdentityRoots({ sessionsRoot });
    try {
      const resolved = resolveGitTreeUid(
        path.join(sessionDir, "workspace"),
        asRoot({ uid: 2_000_024, gid: 2_000_024 }),
      );
      expect(resolved).toEqual({ uid: process.getuid?.(), gid: process.getgid?.() });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("says nothing for a root-owned shared cache — the healthy steady state", () => {
    configureSessionIdentityRoots({ sessionsRoot: "/workspace/sessions" });
    expect(resolveGitTreeUid("/workspace/repo-cache/abc", asRoot({ uid: 0, gid: 0 }))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("names the drop once per tree when a non-session tree IS foreign", () => {
    configureSessionIdentityRoots({ sessionsRoot: "/workspace/sessions" });
    const cache = `/workspace/repo-cache/${Math.abs(process.pid)}-once`;
    resolveGitTreeUid(cache, asRoot({ uid: 1000, gid: 1000 }));
    resolveGitTreeUid(cache, asRoot({ uid: 1000, gid: 1000 }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(" ")).toContain("not uniformly owned");
  });
});

describe("gitSpawnOverridesForTree", () => {
  it("is empty when no drop applies, so call sites can spread unconditionally", () => {
    expect(gitSpawnOverridesForTree("/opt/shipit")).toEqual({});
  });
});
