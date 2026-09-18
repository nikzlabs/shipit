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

    const sel = mgr.selectAccountForTurn("anthropic");
    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel.route).toEqual({ kind: "reserved", id: "claude-api-key" });

    expect(mgr.list("anthropic")).toHaveLength(0);
  });

  it("prefers a subscription account over the API key when both exist", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    const acct = mgr.create("anthropic", "Subscription");
    mgr.setAccountStatus("anthropic", acct.id, "ready");

    const sel = mgr.selectAccountForTurn("anthropic");

    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel.route).toEqual({ kind: "account", id: acct.id });
  });

  it("fails an exhausted subscription rather than rolling onto the API key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    // Keep the reset inside the re-probe cap so its exact time is returned.
    const resetAt = Date.now() + 20 * 60 * 1000;
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    const acct = mgr.create("anthropic", "Subscription");
    mgr.setAccountStatus("anthropic", acct.id, "ready");
    mgr.markAccountExhausted("anthropic", acct.id, resetAt);

    const sel = mgr.selectAccountForTurn("anthropic");

    expect(sel.ok).toBe(false);
    if (!sel.ok && sel.reason === "all_exhausted") {
      expect(sel.earliestResetAt).toBe(new Date(resetAt).toISOString());
    } else {
      expect.unreachable("expected an all_exhausted failure");
    }
  });

  it("prefers the OAuth env route over the API key for Claude", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "oauth-token";
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    const sel = mgr.selectAccountForTurn("anthropic");

    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel.route.id).toBe("claude-env-oauth");
  });

  it("reports auth_required when there is neither an account nor a reserved route", () => {
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    const sel = mgr.selectAccountForTurn("anthropic");

    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.reason).toBe("auth_required");
  });
});
