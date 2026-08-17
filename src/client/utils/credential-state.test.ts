import { describe, it, expect } from "vitest";
import { credentialStatusWord, isUnconnectedAttempt } from "./credential-state.js";
import type { CredentialRoute } from "../../server/shared/types.js";

const now = Date.now();

function route(overrides: Partial<CredentialRoute> = {}): CredentialRoute {
  return {
    id: "acct-work",
    serviceId: "anthropic",
    billingMode: "sub",
    via: "account",
    label: "Work",
    isPrimary: true,
    status: "ready",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// These two predicates are read by both Settings and the header usage pill, so
// their contract is tested here rather than only through whichever component
// happens to render them.
describe("credentialStatusWord", () => {
  it("says nothing about a credential that can run a turn", () => {
    expect(credentialStatusWord(route())).toBeUndefined();
  });

  it("names the remedy the credential actually has (planning#358)", () => {
    // An account has a login to run again; a supplied secret does not — there
    // is nothing to reconnect to, and the only fix is a new value.
    expect(credentialStatusWord(route({ status: "auth_failed" }))).toEqual({
      text: "reconnect needed",
      tone: "error",
    });
    expect(credentialStatusWord(route({ via: "string", status: "auth_failed" }))).toEqual({
      text: "credential rejected",
      tone: "error",
    });
  });

  it("reports an in-flight sign-in as a warning, not a failure", () => {
    expect(credentialStatusWord(route({ status: "authenticating" }))).toEqual({
      text: "signing in…",
      tone: "warning",
    });
  });

  it("falls back to the account remedy for any other non-ready state", () => {
    // `unavailable` today, and whatever a future `CredentialStatus` adds: the
    // default is to say something rather than to fall silent, since silence is
    // read as health. A new state that deserves its own wording will fail this
    // expectation, which is the point.
    expect(credentialStatusWord(route({ status: "unavailable" }))).toEqual({
      text: "reconnect needed",
      tone: "error",
    });
  });
});

describe("isUnconnectedAttempt", () => {
  it("is true only for a row that has never been anything but an attempt", () => {
    expect(isUnconnectedAttempt(route({ status: "unavailable" }))).toBe(true);
    expect(isUnconnectedAttempt(route({ status: "authenticating" }))).toBe(true);
  });

  it("is false once a sign-in reported an identity", () => {
    // Both clauses are load-bearing: a signed-out account is `unavailable`
    // again, and must stay listed so the user can reconnect it.
    expect(isUnconnectedAttempt(route({ status: "unavailable", externalId: "user_1" }))).toBe(false);
    expect(isUnconnectedAttempt(route({ status: "authenticating", externalId: "user_1" }))).toBe(false);
  });

  it("is false for the states only a real login attempt reaches", () => {
    // Covers the account that connected without a readable identity — an
    // unreadable identity proceeds by design, so `externalId` alone over-hides.
    expect(isUnconnectedAttempt(route({ status: "ready" }))).toBe(false);
    expect(isUnconnectedAttempt(route({ status: "auth_failed" }))).toBe(false);
  });

  it("is false for a supplied secret, which has no login flow to be mid-way through", () => {
    expect(isUnconnectedAttempt(route({ via: "string", status: "unavailable" }))).toBe(false);
  });
});
