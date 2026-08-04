import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  sessionStateDir,
  sessionStateDirForWorkspace,
  SESSION_STATE_SUBDIR,
} from "./session-state-dir.js";

describe("sessionStateDirForWorkspace (docs/246)", () => {
  it("resolves the sibling state dir for the standard layout", () => {
    expect(sessionStateDirForWorkspace("/data/sessions/abc/workspace")).toBe(
      path.join("/data/sessions/abc", SESSION_STATE_SUBDIR),
    );
  });

  it("agrees with sessionStateDir on the session dir it derives", () => {
    const sessionDir = "/data/sessions/abc";
    expect(sessionStateDirForWorkspace(path.join(sessionDir, "workspace"))).toBe(
      sessionStateDir(sessionDir),
    );
  });

  // SHI-286 — the pre-`workspace/` flat layout (sessionDir === workspaceDir) is
  // no longer serviceable. It must NOT degrade into a bare `path.dirname`: that
  // yields `<sessionsRoot>/state` for every flat session on the host — one
  // directory, one shared `.install-done` between all of them. Nor may it return
  // a "no state dir" sentinel, which is what used to let callers keep writing
  // ShipIt's artifacts into the user's clone. It refuses.
  it("throws on the legacy flat layout instead of collapsing into sessionsRoot", () => {
    expect(() => sessionStateDirForWorkspace("/data/sessions/abc")).toThrow(
      /<sessionDir>\/workspace/,
    );
  });

  it("never hands two flat-layout clones the same directory (it hands them none)", () => {
    expect(() => sessionStateDirForWorkspace("/data/sessions/abc")).toThrow();
    expect(() => sessionStateDirForWorkspace("/data/sessions/def")).toThrow();
  });

  // A clone with a trailing slash still names the `workspace` segment — the
  // shape the production census checked for separately.
  it("accepts a trailing-slash clone path", () => {
    expect(sessionStateDirForWorkspace("/data/sessions/abc/workspace/")).toBe(
      path.join("/data/sessions/abc", SESSION_STATE_SUBDIR),
    );
  });

  // The resolved state dir is a SIBLING of the clone, never inside it — the
  // property that used to need a separate containment check on the container
  // side. Deriving both sides from this one function makes it structural.
  it("resolves outside the clone it was derived from", () => {
    const clone = "/data/sessions/abc/workspace";
    const rel = path.relative(clone, sessionStateDirForWorkspace(clone));
    expect(rel.startsWith("..")).toBe(true);
  });
});
