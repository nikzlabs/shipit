import { describe, it, expect } from "vitest";
import { autoCommitAllowed, sessionAutoCommitAllowed } from "./auto-commit-gate.js";
import type { SessionInfo } from "../../shared/types.js";

describe("autoCommitAllowed", () => {
  it("refuses the two privileged kinds", () => {
    expect(autoCommitAllowed({ kind: "ops" })).toBe(false);
    expect(autoCommitAllowed({ kind: "sandbox" })).toBe(false);
  });

  it("allows an ordinary session, and anything it cannot classify", () => {
    expect(autoCommitAllowed({})).toBe(true);
    expect(autoCommitAllowed({ kind: undefined })).toBe(true);
    expect(autoCommitAllowed(undefined)).toBe(true);
    expect(autoCommitAllowed(null)).toBe(true);
  });
});

describe("sessionAutoCommitAllowed", () => {
  const manager = (kind?: SessionInfo["kind"]) => ({
    get: (_id: string) => (kind ? ({ kind } as Pick<SessionInfo, "kind">) : undefined),
  });

  it("resolves the kind through the session manager", () => {
    expect(sessionAutoCommitAllowed(manager("ops"), "s1")).toBe(false);
    expect(sessionAutoCommitAllowed(manager("sandbox"), "s1")).toBe(false);
    expect(sessionAutoCommitAllowed(manager(undefined), "s1")).toBe(true);
  });

  it("allows when there is no session id to resolve", () => {
    expect(sessionAutoCommitAllowed(manager("ops"), undefined)).toBe(true);
  });
});
