/**
 * docs/150-multiple-provider-subscriptions reqs 13, 17 — which selection failures stop a turn, and what the
 * user is told when one does.
 *
 * Assertions key off structure (the reason, the reset instant, the model name,
 * the presence of a next step) rather than exact prose, so copy edits don't
 * churn the suite.
 */

import { describe, it, expect } from "vitest";
import {
  ProviderRouteUnavailableError,
  describeAccountSelectionFailure,
  isTurnBlockingFailure,
  routeFromSelection,
} from "./provider-route-preflight.js";

describe("isTurnBlockingFailure", () => {
  it("blocks the turn when quota is spent", () => {
    expect(isTurnBlockingFailure({ reason: "all_exhausted", earliestResetAt: null })).toBe(true);
  });

  // Not-signed-in already has a guided surface (hasRunnableModels, the Settings
  // account rows). Turning it into a thrown turn error would replace that flow
  // with a dead end.
  it("does not block the turn when the user simply has not connected an account", () => {
    expect(isTurnBlockingFailure({ reason: "auth_required" })).toBe(false);
  });
});

describe("describeAccountSelectionFailure", () => {
  it("names the reset instant for an all-exhausted provider (req 13)", () => {
    const resetAt = "2026-08-01T14:30:00.000Z";
    const message = describeAccountSelectionFailure("claude", {
      reason: "all_exhausted",
      earliestResetAt: resetAt,
    });
    expect(message).toContain("Claude");
    expect(message).toContain(resetAt);
    // req 13 — ShipIt does not hold the prompt, so the message must tell the
    // user the resend is theirs to make.
    expect(message.toLowerCase()).toContain("again");
  });

  it("still explains itself when no exhausted window carried a reset time", () => {
    const message = describeAccountSelectionFailure("codex", {
      reason: "all_exhausted",
      earliestResetAt: null,
    });
    expect(message).toContain("Codex");
    expect(message).not.toContain("null");
    expect(message).not.toContain("Invalid Date");
  });

  it("passes an unparseable reset time through verbatim rather than as Invalid Date", () => {
    const message = describeAccountSelectionFailure("claude", {
      reason: "all_exhausted",
      earliestResetAt: "soon-ish",
    });
    expect(message).toContain("soon-ish");
    expect(message).not.toContain("Invalid Date");
  });

});

describe("routeFromSelection", () => {
  it("returns the chosen route unchanged on success", () => {
    expect(routeFromSelection("claude", { ok: true, route: { kind: "account", id: "acct_a" } })).toEqual({
      kind: "account",
      id: "acct_a",
    });
  });

  it("throws a ProviderRouteUnavailableError carrying the structured failure", () => {
    try {
      routeFromSelection("claude", {
        ok: false,
        reason: "all_exhausted",
        earliestResetAt: "2026-08-01T14:30:00.000Z",
      });
      expect.unreachable("expected a blocking failure to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderRouteUnavailableError);
      const blocked = err as ProviderRouteUnavailableError;
      expect(blocked.provider).toBe("claude");
      expect(blocked.failure).toMatchObject({
        reason: "all_exhausted",
        earliestResetAt: "2026-08-01T14:30:00.000Z",
      });
      // The rendered message is the one the user sees, so it must not be empty
      // and must not be the class name.
      expect(blocked.message).toContain("2026-08-01T14:30:00.000Z");
    }
  });

  it("returns undefined for auth_required so the caller keeps its existing path", () => {
    expect(routeFromSelection("codex", { ok: false, reason: "auth_required" })).toBeUndefined();
  });
});
