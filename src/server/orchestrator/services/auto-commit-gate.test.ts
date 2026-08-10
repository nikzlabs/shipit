/**
 * docs/128 / docs/211 — the shared auto-commit gate.
 *
 * The rule itself is three lines; what these tests pin is that it does not
 * WIDEN. Every automatic commit path in the orchestrator now routes through
 * here, so a gate that answered "no" for an ordinary session, or for a session
 * the manager has never heard of, would silently stop committing the whole
 * product's work.
 */

import { describe, it, expect } from "vitest";
import { autoCommitAllowed, sessionAutoCommitAllowed } from "./auto-commit-gate.js";
import type { SessionInfo } from "../../shared/types.js";

describe("autoCommitAllowed", () => {
  it("refuses the two privileged kinds", () => {
    expect(autoCommitAllowed({ kind: "ops" })).toBe(false);
    expect(autoCommitAllowed({ kind: "sandbox" })).toBe(false);
  });

  it("allows an ordinary session, and anything it cannot classify", () => {
    // An ordinary repo-backed / standalone session carries no `kind` at all.
    expect(autoCommitAllowed({})).toBe(true);
    expect(autoCommitAllowed({ kind: undefined })).toBe(true);
    // A session the manager doesn't know (unknown id, minimal test setup) must
    // fail OPEN — the gate narrows two named kinds, it is not a default-deny.
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
    // `postTurnCommit`'s `sessionId` is optional; a missing id must not be read
    // as a refusal.
    expect(sessionAutoCommitAllowed(manager("ops"), undefined)).toBe(true);
  });
});
