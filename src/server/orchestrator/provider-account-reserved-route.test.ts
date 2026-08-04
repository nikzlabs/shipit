/**
 * docs/150 req 12 — a reserved env/API-key route is metered billing, never a
 * subscription account.
 *
 * The requirement is that ShipIt never rolls a spent subscription onto
 * pay-as-you-go billing. The structural half of that guarantee is that
 * configuring an API key must not create or "ready" a stored account row: if it
 * did, the reserved route would become reachable through ordinary account
 * selection and req 12 would depend on ordering inside the selection walk
 * rather than on the two things being different in kind.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credential-store.js";
import { ProviderAccountManager } from "./provider-account-manager.js";

describe("reserved routes never become subscription accounts (req 12)", () => {
  let root: string;
  let store: CredentialStore;
  let savedSessionId: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-reserved-route-"));
    store = new CredentialStore(root);
    savedSessionId = process.env.SHIPIT_SESSION_ID;
    delete process.env.SHIPIT_SESSION_ID;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.OPENAI_API_KEY;
    if (savedSessionId === undefined) delete process.env.SHIPIT_SESSION_ID;
    else process.env.SHIPIT_SESSION_ID = savedSessionId;
  });

  it("configures only the reserved route and invents no account row", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    mgr.migrateDefaultAccounts();

    // The route is available...
    const sel = mgr.selectAccountForTurn("claude");
    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel.route).toEqual({ kind: "reserved", id: "claude-api-key" });

    // ...but nothing appears in the account list, so no UI row, no priority
    // position, and nothing for failover to select as a subscription.
    expect(mgr.list("claude")).toHaveLength(0);
  });

  it("prefers a subscription account over the API key when both exist", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    const acct = mgr.create("claude", "Subscription");
    mgr.setAccountStatus("claude", acct.id, "ready");

    const sel = mgr.selectAccountForTurn("claude");

    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel.route).toEqual({ kind: "account", id: acct.id });
  });

  it("fails an exhausted subscription rather than rolling onto the API key", () => {
    // The heart of req 12. An API key is configured and would work, but a spent
    // subscription must not silently start spending money — the turn fails and
    // the user is told when the window resets.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const resetAt = Date.now() + 45 * 60 * 1000;
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    const acct = mgr.create("claude", "Subscription");
    mgr.setAccountStatus("claude", acct.id, "ready");
    mgr.markAccountExhausted("claude", acct.id, resetAt);

    const sel = mgr.selectAccountForTurn("claude");

    expect(sel.ok).toBe(false);
    if (!sel.ok && sel.reason === "all_exhausted") {
      expect(sel.earliestResetAt).toBe(new Date(resetAt).toISOString());
    } else {
      expect.unreachable("expected an all_exhausted failure");
    }
  });

  it("prefers the OAuth env route over the API key for Claude", () => {
    // `claude-env-oauth` is a subscription token supplied by env, so it is
    // quota-bearing and must outrank metered billing.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "oauth-token";
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    const sel = mgr.selectAccountForTurn("claude");

    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel.route.id).toBe("claude-env-oauth");
  });

  it("reports auth_required when there is neither an account nor a reserved route", () => {
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    const sel = mgr.selectAccountForTurn("claude");

    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.reason).toBe("auth_required");
  });
});
