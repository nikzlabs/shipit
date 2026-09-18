import { afterEach, describe, expect, it } from "vitest";
import {
  configureSessionIdentityRoots,
  identityForPath,
  sessionDirFor,
  sessionIdForPath,
  type SessionIdentityDeps,
} from "./session-identity.js";

const SESSIONS = "/workspace/sessions";
const CREDS = "/credentials/sessions";

afterEach(() => configureSessionIdentityRoots(null));

function owned(owner: { uid: number; gid: number } | null): SessionIdentityDeps {
  return { statOwner: () => owner };
}

describe("sessionIdForPath", () => {
  it("returns null everywhere when the roots are unconfigured", () => {
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
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS, credentialsSessionsRoot: CREDS });
    expect(sessionIdForPath(`${CREDS}/s1/.claude/creds.json`)).toBe("s1");
  });

  it("returns null for a path that belongs to no session", () => {
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS, credentialsSessionsRoot: CREDS });
    expect(sessionIdForPath("/workspace/repo-cache/abc")).toBeNull();
    expect(sessionIdForPath("/workspace/dep-cache/abc")).toBeNull();
    expect(sessionIdForPath(SESSIONS)).toBeNull();
  });

  it("cannot be walked out of the root and back in under another session", () => {
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS });
    expect(sessionIdForPath(`${SESSIONS}/s1/../../elsewhere`)).toBeNull();
    expect(sessionIdForPath(`${SESSIONS}/s1/../s2/workspace`)).toBe("s2");
  });
});

describe("identityForPath", () => {
  it("reads the identity off the SESSION DIRECTORY, not the path it was given", () => {
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
    configureSessionIdentityRoots({ sessionsRoot: SESSIONS });
    expect(identityForPath(`${SESSIONS}/s1/workspace`, owned({ uid: 0, gid: 0 }))).toBeNull();
  });

  it("uses the configured fallback, never the tree, when the record is absent", () => {
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
