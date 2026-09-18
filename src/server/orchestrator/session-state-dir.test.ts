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

  it("throws on the legacy flat layout instead of collapsing into sessionsRoot", () => {
    expect(() => sessionStateDirForWorkspace("/data/sessions/abc")).toThrow(
      /<sessionDir>\/workspace/,
    );
  });

  it("never hands two flat-layout clones the same directory (it hands them none)", () => {
    expect(() => sessionStateDirForWorkspace("/data/sessions/abc")).toThrow();
    expect(() => sessionStateDirForWorkspace("/data/sessions/def")).toThrow();
  });

  it("accepts a trailing-slash clone path", () => {
    expect(sessionStateDirForWorkspace("/data/sessions/abc/workspace/")).toBe(
      path.join("/data/sessions/abc", SESSION_STATE_SUBDIR),
    );
  });

  it("resolves outside the clone it was derived from", () => {
    const clone = "/data/sessions/abc/workspace";
    const rel = path.relative(clone, sessionStateDirForWorkspace(clone));
    expect(rel.startsWith("..")).toBe(true);
  });
});
