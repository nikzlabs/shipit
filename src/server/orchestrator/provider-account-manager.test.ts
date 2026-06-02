import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credential-store.js";
import { ProviderAccountManager } from "./provider-account-manager.js";
import type { AgentAuthManager, AgentAuthStartOptions, AgentAuthScopeOptions } from "./agent-auth-manager.js";
import type { AgentId } from "../shared/types.js";

/**
 * Minimal fake {@link AgentAuthManager} that records the scoped options it was
 * driven with, so the orchestration tests can assert routing without spawning
 * a real CLI. `configured` simulates whether the account dir has credentials.
 */
class FakeAuthManager extends EventEmitter implements AgentAuthManager {
  startCalls: AgentAuthStartOptions[] = [];
  cancelCalls = 0;
  signOutCalls: AgentAuthScopeOptions[] = [];
  codeCalls: string[] = [];
  configured = false;
  hasSubmitCode = true;
  constructor(readonly agentId: AgentId) { super(); }
  start(opts?: AgentAuthStartOptions): void { this.startCalls.push(opts ?? {}); }
  cancel(): void { this.cancelCalls++; }
  submitCode(code: string): void { this.codeCalls.push(code); }
  signOut(opts?: AgentAuthScopeOptions): void { this.signOutCalls.push(opts ?? {}); }
  isConfigured(): boolean { return this.configured; }
  getActiveAccountId(): string | null { return null; }
  getPendingPayload() { return null; }
  kill(): void { /* no-op */ }
}

describe("ProviderAccountManager", () => {
  let root: string;
  let store: CredentialStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-provider-accounts-"));
    store = new CredentialStore(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.OPENAI_API_KEY;
  });

  it("migrates legacy Claude credentials into a primary default account", () => {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", ".credentials.json"), "{}");
    fs.writeFileSync(path.join(root, ".claude.json"), "{}");

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    mgr.migrateDefaultAccounts();

    const account = mgr.getPrimary("claude");
    expect(account).toMatchObject({
      id: "claude-default",
      provider: "claude",
      isPrimary: true,
      status: "ready",
    });
    expect(fs.existsSync(path.join(root, "provider-accounts", "claude", "claude-default", ".claude", ".credentials.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".claude", ".credentials.json"))).toBe(true);
  });

  it("does not create an account when only reserved env auth exists", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "token";

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    mgr.migrateDefaultAccounts();

    expect(mgr.list("claude")).toEqual([]);
    expect(mgr.hasAnyAuthForProvider("claude")).toBe(true);
    expect(mgr.selectRouteForTurn("claude")).toEqual({ kind: "reserved", id: "claude-env-oauth" });
  });

  it("selects the primary stored account before API-key fallbacks", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const now = Date.now();
    store.upsertProviderAccount({
      id: "codex-default",
      provider: "codex",
      label: "Primary ChatGPT account",
      isPrimary: true,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    });

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    expect(mgr.hasAnyAuthForProvider("codex")).toBe(true);
    expect(mgr.selectRouteForTurn("codex")).toEqual({ kind: "account", id: "codex-default" });
  });

  describe("account-scoped auth flows (docs/150)", () => {
    function setup() {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const claude = new FakeAuthManager("claude");
      const codex = new FakeAuthManager("codex");
      mgr.attachAuthManagers(new Map([["claude", claude], ["codex", codex]]));
      const account = mgr.create("claude", "Work");
      return { mgr, claude, codex, account };
    }

    it("startAccountAuth marks the row authenticating and drives the manager with the account credential root", () => {
      const { mgr, claude, account } = setup();
      const result = mgr.startAccountAuth("claude", account.id);

      expect(result.status).toBe("authenticating");
      expect(mgr.get("claude", account.id)?.status).toBe("authenticating");
      expect(claude.startCalls).toHaveLength(1);
      expect(claude.startCalls[0]).toEqual({
        accountId: account.id,
        credentialDir: mgr.resolveCredentialRoot("claude", account.id),
      });
    });

    it("cancelAccountAuth resets status from the on-disk credential check", () => {
      const { mgr, claude, account } = setup();
      mgr.startAccountAuth("claude", account.id);

      claude.configured = false;
      expect(mgr.cancelAccountAuth("claude", account.id).status).toBe("unavailable");
      expect(claude.cancelCalls).toBe(1);

      mgr.startAccountAuth("claude", account.id);
      claude.configured = true;
      expect(mgr.cancelAccountAuth("claude", account.id).status).toBe("ready");
    });

    it("submitAccountCode delegates to the manager's submitCode", () => {
      const { mgr, claude, account } = setup();
      mgr.submitAccountCode("claude", account.id, "abc-123");
      expect(claude.codeCalls).toEqual(["abc-123"]);
    });

    it("submitAccountCode throws when the provider flow has no code step", () => {
      const { mgr, codex, account } = setup();
      const codexAccount = mgr.create("codex", "Personal");
      (codex as { submitCode?: unknown }).submitCode = undefined;
      expect(() => mgr.submitAccountCode("codex", codexAccount.id, "x")).toThrow(/no code-submission step/i);
      expect(account).toBeDefined();
    });

    it("signOutAccount removes the account credentials and marks the row unavailable", () => {
      const { mgr, claude, account } = setup();
      mgr.setAccountStatus("claude", account.id, "ready");
      const result = mgr.signOutAccount("claude", account.id);
      expect(result.status).toBe("unavailable");
      expect(claude.signOutCalls[0]).toEqual({
        credentialDir: mgr.resolveCredentialRoot("claude", account.id),
      });
    });

    it("scoped-auth methods throw a clear error when no auth managers are wired", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const account = mgr.create("claude");
      expect(() => mgr.startAccountAuth("claude", account.id)).toThrow(/no auth manager wired/i);
    });
  });
});
