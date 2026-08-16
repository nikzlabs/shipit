/**
 * docs/270 — which session a path belongs to, and what that session's identity
 * is.
 *
 * The interesting state (a directory owned by a uid that is not ours) cannot be
 * produced in a session container: there is no root and `unshare -r` is refused.
 * That is why {@link identityForPath} takes its `statOwner` injected — the
 * decision is pure and testable even where the environment is not.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  configureSessionIdentityRoots,
  identityForPath,
  sessionDirFor,
  sessionIdForPath,
  sessionsRootOrNull,
  type SessionIdentityDeps,
} from "./session-identity.js";

const SESSIONS = "/workspace/sessions";
const CREDS = "/credentials/sessions";

afterEach(() => configureSessionIdentityRoots(null));

/** "every session directory is owned by `owner`". */
function owned(owner: { uid: number; gid: number } | null): SessionIdentityDeps {
  return { statOwner: () => owner };
}

describe("sessionIdForPath", () => {
  it("returns null everywhere when the roots are unconfigured", () => {
    // Local mode, dogfood, and every test. This is what keeps docs/270 inert
    // outside a containerized production orchestrator.
    expect(sessionsRootOrNull()).toBeNull();
    expect(sessionIdForPath(`${SESSIONS}/s1/workspace`)).toBeNull();
  });

  it("names the session for a path inside its workspace", () => {
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS });
    expect(sessionIdForPath(`${SESSIONS}/s1/workspace/src/a.ts`)).toBe("s1");
  });

  it("names the session for the session directory itself", () => {
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS });
    expect(sessionIdForPath(`${SESSIONS}/s1`)).toBe("s1");
  });

  it("names the session for its private credentials subtree", () => {
    // The second root exists so a chown of a per-session credential file
    // resolves to the SAME identity a chown inside that session's workspace
    // does — the credentials tree is a different volume, not a child of the
    // sessions root.
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS, credentialsSessionsRoot: CREDS });
    expect(sessionIdForPath(`${CREDS}/s1/.claude/creds.json`)).toBe("s1");
  });

  it("returns null for a path that belongs to no session", () => {
    // The shared bare cache, the dep cache, /opt/shipit. These must keep their
    // pre-docs/270 handling, which callers express as "fall back to the global".
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS, credentialsSessionsRoot: CREDS });
    expect(sessionIdForPath("/workspace/repo-cache/abc")).toBeNull();
    expect(sessionIdForPath("/workspace/dep-cache/abc")).toBeNull();
    expect(sessionIdForPath(SESSIONS)).toBeNull();
  });

  it("cannot be walked out of the root and back in under another session", () => {
    // `..` is resolved before the comparison, so a path that leaves the sessions
    // root is not inside it, whatever it re-enters as. Without this, a caller
    // holding an unnormalized path could resolve one session's identity for
    // another session's tree.
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS });
    expect(sessionIdForPath(`${SESSIONS}/s1/../../elsewhere`)).toBeNull();
    expect(sessionIdForPath(`${SESSIONS}/s1/../s2/workspace`)).toBe("s2");
  });
});

describe("identityForPath", () => {
  it("reads the identity off the SESSION DIRECTORY, not the path it was given", () => {
    // The whole point of req 2. `statOwner` is asked exactly once, for
    // `<sessionsRoot>/<id>` — a directory `buildMounts` mounts into nothing, so
    // no compose service can chown it. The workspace below it can be re-owned
    // from inside the session and must not be what decides.
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS });
    const asked: string[] = [];
    const deps: SessionIdentityDeps = {
      statOwner: (dir) => {
        asked.push(dir);
        return { uid: 2_000_007, gid: 1000 };
      },
    };
    expect(identityForPath(`${SESSIONS}/s1/workspace/.git`, deps))
      .toEqual({ uid: 2_000_007, gid: 1000 });
    expect(asked).toEqual([`${SESSIONS}/s1`]);
  });

  it("carries the shared gid rather than deriving one from the uid", () => {
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS });
    expect(identityForPath(`${SESSIONS}/s1/workspace`, owned({ uid: 2_000_007, gid: 1000 })))
      .toEqual({ uid: 2_000_007, gid: 1000 });
  });

  it("returns null for a session directory that is still root-owned", () => {
    // "root" here is the ABSENCE of a record — a session directory the
    // orchestrator has not sealed yet — not a record saying root. Callers fall
    // back to the global value, which is what a pre-docs/270 session had.
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS });
    expect(identityForPath(`${SESSIONS}/s1/workspace`, owned({ uid: 0, gid: 0 }))).toBeNull();
  });

  it("uses the configured fallback, never the tree, when the record is absent", () => {
    // A session directory with no record means its seal did not run or did not
    // succeed. The honest answer is the value the deployment configured — which
    // no session can choose — and specifically NOT whatever the workspace
    // happens to be owned by, since a root compose service can chown that.
    configureSessionIdentityRoots({
      sessionsRoot: SESSIONS,
      fallbackIdentity: { uid: 1000, gid: 1000 },
    });
    expect(identityForPath(`${SESSIONS}/s1/workspace`, owned({ uid: 0, gid: 0 })))
      .toEqual({ uid: 1000, gid: 1000 });
    expect(identityForPath(`${SESSIONS}/s1/workspace`, owned(null)))
      .toEqual({ uid: 1000, gid: 1000 });
  });

  it("does not extend the fallback to paths outside a session", () => {
    // The bare cache must keep resolving to "not a session path", or callers
    // would start chowning ShipIt's own trees to a session identity.
    configureSessionIdentityRoots({
      sessionsRoot: SESSIONS,
      fallbackIdentity: { uid: 1000, gid: 1000 },
    });
    expect(identityForPath("/workspace/repo-cache/abc", owned(null))).toBeNull();
  });

  it("returns null when the session directory has vanished", () => {
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS });
    expect(identityForPath(`${SESSIONS}/s1/workspace`, owned(null))).toBeNull();
  });

  it("returns null for a non-session path even when the roots are configured", () => {
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS });
    expect(identityForPath("/workspace/repo-cache/abc", owned({ uid: 1000, gid: 1000 })))
      .toBeNull();
  });
});

describe("sessionDirFor", () => {
  it("is null until the roots are configured", () => {
    expect(sessionDirFor("s1")).toBeNull();
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS });
    expect(sessionDirFor("s1")).toBe(`${SESSIONS}/s1`);
  });
});
