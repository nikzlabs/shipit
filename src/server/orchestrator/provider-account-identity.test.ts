/**
 * docs/150 req 22 — account identity at connect time.
 *
 * Two things are under test and they fail differently, so they are separated:
 * *reading* an identity out of what the provider CLI wrote (pure filesystem
 * parsing, exercised against real files rather than a mocked `fs` so a wrong
 * path is a failure rather than a passing test of the wrong string), and the
 * *policy* applied to it, which is exercised against the real
 * `ProviderAccountManager` so a refusal's on-disk consequences are asserted
 * rather than assumed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credential-store.js";
import { ProviderAccountManager } from "./provider-account-manager.js";
import {
  readProviderAccountIdentity,
  refuseIfAlreadyConnected,
} from "./provider-account-identity.js";

/** Minimal JWT with the given payload — only the payload segment is read. */
function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${body}.signature`;
}

const OPENAI_CLAIM = "https://api.openai.com/auth";

describe("reading provider account identity (req 22)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-identity-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads Claude's accountUuid and email from .claude.json", () => {
    fs.writeFileSync(
      path.join(root, ".claude.json"),
      JSON.stringify({
        oauthAccount: { accountUuid: "uuid-1", emailAddress: "dev@example.com" },
        projects: {},
      }),
    );

    expect(readProviderAccountIdentity("claude", root)).toEqual({
      externalId: "uuid-1",
      email: "dev@example.com",
    });
  });

  it("does not mistake Claude plan data for identity", () => {
    // `.credentials.json` is the file it would be natural to reach for, and it
    // is the wrong one: `subscriptionType` is a PLAN, so two different accounts
    // on Max are indistinguishable by it. With no `.claude.json` there is no
    // identity, and the connect degrades rather than inventing a shared key.
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { subscriptionType: "max", rateLimitTier: "default" } }),
    );

    expect(readProviderAccountIdentity("claude", root)).toBeNull();
  });

  it("reads Codex's chatgpt_account_id and email from the id_token claim", () => {
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".codex", "auth.json"),
      JSON.stringify({
        tokens: {
          id_token: jwt({
            email: "dev@example.com",
            [OPENAI_CLAIM]: { chatgpt_account_id: "chatgpt-1", chatgpt_plan_type: "pro" },
          }),
        },
      }),
    );

    expect(readProviderAccountIdentity("codex", root)).toEqual({
      externalId: "chatgpt-1",
      email: "dev@example.com",
    });
  });

  it("returns null rather than throwing on missing, malformed, or identity-less files", () => {
    expect(readProviderAccountIdentity("claude", root)).toBeNull();

    fs.writeFileSync(path.join(root, ".claude.json"), "{ not json");
    expect(readProviderAccountIdentity("claude", root)).toBeNull();

    // An older CLI writes the config without `oauthAccount` at all.
    fs.writeFileSync(path.join(root, ".claude.json"), JSON.stringify({ projects: {} }));
    expect(readProviderAccountIdentity("claude", root)).toBeNull();
  });
});

describe("connect-time identity policy (req 22)", () => {
  let root: string;
  let store: CredentialStore;
  let accounts: ProviderAccountManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-identity-policy-"));
    store = new CredentialStore(root);
    accounts = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Write what a completed Claude sign-in leaves in an account's root. */
  function writeClaudeSignIn(accountId: string, uuid: string, email?: string): void {
    const dir = accounts.resolveCredentialRoot("claude", accountId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: uuid, ...(email ? { emailAddress: email } : {}) } }),
    );
  }

  it("records the external id and adopts the reported email as the label", () => {
    const account = accounts.create("claude");
    expect(account.label).toBe("Claude");
    writeClaudeSignIn(account.id, "uuid-1", "dev@example.com");

    expect(refuseIfAlreadyConnected("claude", account.id, accounts)).toBeNull();

    const stored = accounts.get("claude", account.id);
    expect(stored?.externalId).toBe("uuid-1");
    expect(stored?.label).toBe("dev@example.com");
  });

  it("leaves a user-typed label alone", () => {
    const account = accounts.create("claude");
    accounts.rename("claude", account.id, "Work");
    writeClaudeSignIn(account.id, "uuid-1", "dev@example.com");

    refuseIfAlreadyConnected("claude", account.id, accounts);

    expect(accounts.get("claude", account.id)?.label).toBe("Work");
    expect(accounts.get("claude", account.id)?.externalId).toBe("uuid-1");
  });

  it("degrades to the generated label when the CLI reports no identity", () => {
    // An older CLI, or an env-only route. The connect must still succeed —
    // refusing everything ShipIt cannot identify would make such an install
    // unable to connect any account at all.
    const account = accounts.create("claude");

    expect(refuseIfAlreadyConnected("claude", account.id, accounts)).toBeNull();

    const stored = accounts.get("claude", account.id);
    expect(stored?.label).toBe("Claude");
    expect(stored?.externalId).toBeUndefined();
  });

  it("refuses a second connect resolving to an existing external id, and removes the new row", () => {
    const first = accounts.create("claude");
    writeClaudeSignIn(first.id, "uuid-1", "dev@example.com");
    refuseIfAlreadyConnected("claude", first.id, accounts);
    accounts.setAccountStatus("claude", first.id, "ready");

    const second = accounts.create("claude");
    writeClaudeSignIn(second.id, "uuid-1", "dev@example.com");

    const message = refuseIfAlreadyConnected("claude", second.id, accounts);

    expect(message).toContain("already connected");
    expect(message).toContain("dev@example.com");
    // req 22 — no second row for the same account...
    expect(accounts.list("claude")).toHaveLength(1);
    expect(accounts.get("claude", second.id)).toBeUndefined();
    // ...and the existing row is untouched: same id, same status, same label.
    const kept = accounts.get("claude", first.id);
    expect(kept?.status).toBe("ready");
    expect(kept?.label).toBe("dev@example.com");
    expect(fs.existsSync(path.join(accounts.resolveCredentialRoot("claude", first.id), ".claude.json"))).toBe(true);
  });

  it("lets a stale row re-authenticate into its own account", () => {
    // The consequence the user accepted when choosing refusal over adopting:
    // re-connecting is no longer a repair path, so the row's OWN Reconnect
    // action has to keep working. It resolves to the same external id the row
    // already holds, which is a self-match and must not be refused.
    const account = accounts.create("claude");
    writeClaudeSignIn(account.id, "uuid-1", "dev@example.com");
    refuseIfAlreadyConnected("claude", account.id, accounts);
    accounts.setAccountStatus("claude", account.id, "auth_failed");

    writeClaudeSignIn(account.id, "uuid-1", "dev@example.com");
    expect(refuseIfAlreadyConnected("claude", account.id, accounts)).toBeNull();

    expect(accounts.list("claude")).toHaveLength(1);
    expect(accounts.get("claude", account.id)?.externalId).toBe("uuid-1");
  });

  it("keeps an established row when a DIFFERENT account is signed into it", () => {
    // Not the same case as a fresh "Add account": this row has a priority
    // position, a name, and possibly pinned sessions. Deleting it because the
    // user picked the wrong account in the browser would take all of that with
    // it, so the row survives — credential-less and `auth_failed`.
    const first = accounts.create("claude");
    writeClaudeSignIn(first.id, "uuid-1", "first@example.com");
    refuseIfAlreadyConnected("claude", first.id, accounts);

    const second = accounts.create("claude");
    writeClaudeSignIn(second.id, "uuid-2", "second@example.com");
    refuseIfAlreadyConnected("claude", second.id, accounts);
    accounts.setAccountStatus("claude", second.id, "ready");

    // Now the user re-connects the second row but signs in as the FIRST account.
    writeClaudeSignIn(second.id, "uuid-1", "first@example.com");
    const message = refuseIfAlreadyConnected("claude", second.id, accounts);

    expect(message).toContain('already connected as "first@example.com"');
    expect(accounts.list("claude")).toHaveLength(2);
    const kept = accounts.get("claude", second.id);
    expect(kept?.status).toBe("auth_failed");
    expect(kept?.externalId).toBe("uuid-2");
    // The credentials that would have made it a working duplicate are gone.
    expect(
      fs.existsSync(path.join(accounts.resolveCredentialRoot("claude", second.id), ".claude.json")),
    ).toBe(false);
  });
});
