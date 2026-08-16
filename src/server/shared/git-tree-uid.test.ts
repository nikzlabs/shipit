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
  type GitTreeUidDeps,
} from "./git-tree-uid.js";
import { configureSessionIdentityRoots } from "./session-identity.js";

afterEach(() => configureSessionIdentityRoots(null));

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

describe("resolveGitTreeUid under per-session identities (docs/268)", () => {
  // These use the REAL `statOwner` for the session directory, via the module's
  // own default deps, so they exercise the path a production call takes. The
  // injected deps below stand in only for the tree.
  it("takes the identity from the session directory, not from the tree", () => {
    // Req 2, stated as a test: an Open session's compose service may run as root
    // (the numeric-non-root `user:` rule covers CONTAINED services only), so it
    // can `chown` its own workspace. If the tree decided, that would let session
    // A name the uid ShipIt's git — and any `.git/config` payload it executes —
    // runs as. The session directory is mounted into nothing, so it cannot.
    configureSessionIdentityRoots({ sessionsRoot: "/workspace/sessions" });
    // The tree claims to belong to some other session…
    const treeSaysSomeoneElse = asRoot({ uid: 2_000_999, gid: 1000 });
    // …but there is no real `/workspace/sessions/s1` to stat, so the session
    // record is absent and the tree is NOT trusted to fill in for it.
    expect(resolveGitTreeUid("/workspace/sessions/s1/workspace", treeSaysSomeoneElse))
      .toBeNull();
  });

  it("still uses the tree for a path that belongs to no session", () => {
    // The shared bare cache keeps its docs/266 behaviour: root-owned, so no
    // drop. A path outside the sessions root must not become undecidable just
    // because the roots are configured.
    configureSessionIdentityRoots({ sessionsRoot: "/workspace/sessions" });
    expect(resolveGitTreeUid("/workspace/repo-cache/abc", asRoot({ uid: 0, gid: 0 })))
      .toBeNull();
    expect(resolveGitTreeUid("/workspace/repo-cache/abc", asRoot({ uid: 1000, gid: 1000 })))
      .toEqual({ uid: 1000, gid: 1000 });
  });

  it("is unchanged when the roots are unconfigured", () => {
    // Local mode and every test: docs/266's behaviour, byte for byte.
    expect(resolveGitTreeUid("/workspace/sessions/s1/workspace", asRoot({ uid: 1000, gid: 1000 })))
      .toEqual({ uid: 1000, gid: 1000 });
  });
});

describe("gitSpawnOverridesForTree", () => {
  it("is empty when no drop applies, so call sites can spread unconditionally", () => {
    // The point of returning `{}` rather than undefined: every raw git spawn
    // spreads this the same way whether or not the deployment drops uid.
    expect(gitSpawnOverridesForTree("/opt/shipit")).toEqual({});
  });
});
