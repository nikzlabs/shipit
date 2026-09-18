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

  it("reads Grok's user_id and email from the scope-keyed .grok/auth.json", () => {
    fs.mkdirSync(path.join(root, ".grok"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".grok", "auth.json"),
      JSON.stringify({
        "grok-build": {
          access_token: "tok",
          refresh_token: "ref",
          user_id: "0195c0de-1234-7890-abcd-ef0123456789",
          email: "dev@example.com",
        },
      }),
    );

    expect(readProviderAccountIdentity("grok", root)).toEqual({
      externalId: "0195c0de-1234-7890-abcd-ef0123456789",
      email: "dev@example.com",
    });
  });

  it("does not mistake Grok's plan for identity", () => {
    fs.mkdirSync(path.join(root, ".grok"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".grok", "auth.json"),
      JSON.stringify({ "grok-build": { access_token: "tok", plan: "supergrok" } }),
    );

    expect(readProviderAccountIdentity("grok", root)).toBeNull();
  });

  it("returns null rather than throwing on missing, malformed, or identity-less files", () => {
    expect(readProviderAccountIdentity("claude", root)).toBeNull();

    fs.writeFileSync(path.join(root, ".claude.json"), "{ not json");
    expect(readProviderAccountIdentity("claude", root)).toBeNull();

    fs.writeFileSync(path.join(root, ".claude.json"), JSON.stringify({ projects: {} }));
    expect(readProviderAccountIdentity("claude", root)).toBeNull();

    expect(readProviderAccountIdentity("grok", root)).toBeNull();
    fs.mkdirSync(path.join(root, ".grok"), { recursive: true });
    fs.writeFileSync(path.join(root, ".grok", "auth.json"), "{ not json");
    expect(readProviderAccountIdentity("grok", root)).toBeNull();

    expect(readProviderAccountIdentity("opencode", root)).toBeNull();
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

  function writeClaudeSignIn(accountId: string, uuid: string, email?: string): void {
    const dir = accounts.resolveCredentialRoot("claude", accountId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: uuid, ...(email ? { emailAddress: email } : {}) } }),
    );
  }

  it("records the external id and adopts the reported email as the label", () => {
    const account = accounts.create("anthropic");
    expect(account.label).toBe("Claude");
    writeClaudeSignIn(account.id, "uuid-1", "dev@example.com");

    expect(refuseIfAlreadyConnected("claude", account.id, accounts)).toBeNull();

    const stored = accounts.get("anthropic", account.id);
    expect(stored?.externalId).toBe("uuid-1");
    expect(stored?.label).toBe("dev@example.com");
  });

  it("leaves a user-typed label alone", () => {
    const account = accounts.create("anthropic");
    accounts.rename("anthropic", account.id, "Work");
    writeClaudeSignIn(account.id, "uuid-1", "dev@example.com");

    refuseIfAlreadyConnected("claude", account.id, accounts);

    expect(accounts.get("anthropic", account.id)?.label).toBe("Work");
    expect(accounts.get("anthropic", account.id)?.externalId).toBe("uuid-1");
  });

  it("degrades to the generated label when the CLI reports no identity", () => {
    const account = accounts.create("anthropic");

    expect(refuseIfAlreadyConnected("claude", account.id, accounts)).toBeNull();

    const stored = accounts.get("anthropic", account.id);
    expect(stored?.label).toBe("Claude");
    expect(stored?.externalId).toBeUndefined();
  });

  it("refuses a second connect resolving to an existing external id, and removes the new row", () => {
    const first = accounts.create("anthropic");
    writeClaudeSignIn(first.id, "uuid-1", "dev@example.com");
    refuseIfAlreadyConnected("claude", first.id, accounts);
    accounts.setAccountStatus("anthropic", first.id, "ready");

    const second = accounts.create("anthropic");
    writeClaudeSignIn(second.id, "uuid-1", "dev@example.com");

    const message = refuseIfAlreadyConnected("claude", second.id, accounts);

    expect(message).toContain("already connected");
    expect(message).toContain("dev@example.com");
    expect(accounts.list("anthropic")).toHaveLength(1);
    expect(accounts.get("anthropic", second.id)).toBeUndefined();
    const kept = accounts.get("anthropic", first.id);
    expect(kept?.status).toBe("ready");
    expect(kept?.label).toBe("dev@example.com");
    expect(fs.existsSync(path.join(accounts.resolveCredentialRoot("claude", first.id), ".claude.json"))).toBe(true);
  });

  it("lets a stale row re-authenticate into its own account", () => {
    const account = accounts.create("anthropic");
    writeClaudeSignIn(account.id, "uuid-1", "dev@example.com");
    refuseIfAlreadyConnected("claude", account.id, accounts);
    accounts.setAccountStatus("anthropic", account.id, "auth_failed");

    writeClaudeSignIn(account.id, "uuid-1", "dev@example.com");
    expect(refuseIfAlreadyConnected("claude", account.id, accounts)).toBeNull();

    expect(accounts.list("anthropic")).toHaveLength(1);
    expect(accounts.get("anthropic", account.id)?.externalId).toBe("uuid-1");
  });

  it("keeps an established row when a DIFFERENT account is signed into it", () => {
    const first = accounts.create("anthropic");
    writeClaudeSignIn(first.id, "uuid-1", "first@example.com");
    refuseIfAlreadyConnected("claude", first.id, accounts);

    const second = accounts.create("anthropic");
    writeClaudeSignIn(second.id, "uuid-2", "second@example.com");
    refuseIfAlreadyConnected("claude", second.id, accounts);
    accounts.setAccountStatus("anthropic", second.id, "ready");

    writeClaudeSignIn(second.id, "uuid-1", "first@example.com");
    const message = refuseIfAlreadyConnected("claude", second.id, accounts);

    expect(message).toContain('already connected as "first@example.com"');
    expect(accounts.list("anthropic")).toHaveLength(2);
    const kept = accounts.get("anthropic", second.id);
    expect(kept?.status).toBe("auth_failed");
    expect(kept?.externalId).toBe("uuid-2");
    expect(
      fs.existsSync(path.join(accounts.resolveCredentialRoot("claude", second.id), ".claude.json")),
    ).toBe(false);
  });
});
