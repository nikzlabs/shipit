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
  /**
   * Mirrors the real managers: one process per provider, so `start` claims the
   * scope and `cancel` releases it. Tests that never start a flow see `null`,
   * exactly as before.
   */
  activeAccountId: string | null = null;
  /** Set to make `start()` throw, standing in for a failed CLI spawn. */
  startShouldThrow: Error | null = null;
  start(opts: AgentAuthStartOptions): void {
    this.startCalls.push(opts);
    if (this.startShouldThrow) throw this.startShouldThrow;
    this.activeAccountId = opts.accountId;
  }
  cancel(): void { this.cancelCalls++; this.activeAccountId = null; }
  submitCode(code: string): void { this.codeCalls.push(code); }
  signOut(opts?: AgentAuthScopeOptions): void { this.signOutCalls.push(opts ?? {}); }
  isConfigured(): boolean { return this.configured; }
  getActiveAccountId(): string | null { return this.activeAccountId; }
  getPendingPayload() { return null; }
  kill(): void { /* no-op */ }
}

describe("ProviderAccountManager", () => {
  let root: string;
  let store: CredentialStore;
  /**
   * The migration guard reads `SHIPIT_SESSION_ID` to detect "I am inside a
   * session container, so `credentialsDir` is a live agent home". That env var
   * is genuinely set whenever this suite runs inside ShipIt (dogfooding), which
   * would otherwise flip every migration test to the refusal path depending on
   * where it ran. Pin it off here and let the tests that care set it.
   */
  let savedSessionId: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-provider-accounts-"));
    store = new CredentialStore(root);
    savedSessionId = process.env.SHIPIT_SESSION_ID;
    delete process.env.SHIPIT_SESSION_ID;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.OPENAI_API_KEY;
    if (savedSessionId === undefined) delete process.env.SHIPIT_SESSION_ID;
    else process.env.SHIPIT_SESSION_ID = savedSessionId;
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
    // req 19 — migration no longer leaves an alias behind, so the credentials
    // exist at exactly one place. What remains at the flat root is an empty
    // real directory, because `/root/.claude` is an image symlink to it.
    expect(fs.existsSync(path.join(root, ".claude", ".credentials.json"))).toBe(false);
    expect(fs.lstatSync(path.join(root, ".claude")).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(path.join(root, ".claude"))).toEqual([]);
    expect(fs.existsSync(path.join(root, ".claude.json"))).toBe(false);
  });

  // req 19 — the alias symlinks are the thing being removed, and installs that
  // already have them must converge on the same shape as a fresh migration.
  it("retires an existing legacy alias symlink, leaving a real empty config dir", () => {
    const accountRoot = path.join(root, "provider-accounts", "claude", "claude-default");
    fs.mkdirSync(path.join(accountRoot, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(accountRoot, ".claude", ".credentials.json"), "{}");
    fs.writeFileSync(path.join(accountRoot, ".claude.json"), "{}");
    fs.symlinkSync(path.join(accountRoot, ".claude"), path.join(root, ".claude"));
    fs.symlinkSync(path.join(accountRoot, ".claude.json"), path.join(root, ".claude.json"));
    const now = Date.now();
    store.upsertProviderAccount({
      id: "claude-default", provider: "claude", label: "Primary Anthropic account",
      isPrimary: true, status: "ready", createdAt: now, updatedAt: now,
    });

    new ProviderAccountManager({ credentialsDir: root, credentialStore: store }).migrateDefaultAccounts();

    expect(fs.lstatSync(path.join(root, ".claude")).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(path.join(root, ".claude"))).toEqual([]);
    // A file-shaped alias needs no placeholder — a write through the dangling
    // image symlink creates it.
    expect(fs.existsSync(path.join(root, ".claude.json"))).toBe(false);
    // The account's own credentials are untouched.
    expect(fs.existsSync(path.join(accountRoot, ".claude", ".credentials.json"))).toBe(true);
    expect(fs.existsSync(path.join(accountRoot, ".claude.json"))).toBe(true);
  });

  // The sweep must never mistake un-migrated credentials for an alias: they are
  // the only copy, and the migration that would move them has not run.
  it("leaves a real (un-aliased) legacy directory alone", () => {
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "auth.json"), "{}");
    const now = Date.now();
    // A pre-existing row makes `migrateProviderDefault` bail, so only the alias
    // sweep runs over this directory.
    store.upsertProviderAccount({
      id: "acct_other", provider: "codex", label: "Work",
      isPrimary: true, status: "ready", createdAt: now, updatedAt: now,
    });

    new ProviderAccountManager({ credentialsDir: root, credentialStore: store }).migrateDefaultAccounts();

    expect(fs.readFileSync(path.join(root, ".codex", "auth.json"), "utf8")).toBe("{}");
  });

  // A symlink the sweep did not create (an operator's mount indirection) points
  // outside `provider-accounts/` and is not ours to remove.
  it("leaves a symlink pointing outside provider-accounts alone", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-elsewhere-"));
    try {
      fs.mkdirSync(path.join(elsewhere, "creds"), { recursive: true });
      fs.symlinkSync(path.join(elsewhere, "creds"), path.join(root, ".codex"));
      const now = Date.now();
      store.upsertProviderAccount({
        id: "acct_other", provider: "codex", label: "Work",
        isPrimary: true, status: "ready", createdAt: now, updatedAt: now,
      });

      new ProviderAccountManager({ credentialsDir: root, credentialStore: store }).migrateDefaultAccounts();

      expect(fs.lstatSync(path.join(root, ".codex")).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  /**
   * The migration is a one-shot for the ORCHESTRATOR's credentials volume, but
   * `app-di` hands it whatever `credentialsDir` resolved to — and inside a
   * session container that is the session's own live agent home (the container
   * mounts `<root>/sessions/<id>` at `/credentials`). Running the test suite
   * in-container therefore moved the running CLI's `.claude/` — credential and
   * conversation jsonl both — into `provider-accounts/claude/claude-default/`,
   * and every turn afterwards failed with "Not logged in · Please run /login".
   *
   * Two independent guards, tested separately below, because either alone
   * leaves a live home reachable: refuse to migrate in a session container at
   * all, and never destroy the source before the copy is confirmed.
   */
  describe("live-home safety", () => {
    // `SHIPIT_SESSION_ID` is cleared by the outer `beforeEach` and restored by
    // the outer `afterEach`, so setting it here needs no local teardown.
    it("refuses to migrate when running inside a session container", () => {
      process.env.SHIPIT_SESSION_ID = "sess-live-123";
      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(root, ".claude", ".credentials.json"), '{"token":"live"}');
      fs.writeFileSync(path.join(root, ".claude.json"), '{"conversation":"live"}');

      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      mgr.migrateDefaultAccounts();

      // The home is untouched — this is the assertion that the session lives.
      expect(fs.readFileSync(path.join(root, ".claude", ".credentials.json"), "utf8"))
        .toBe('{"token":"live"}');
      expect(fs.readFileSync(path.join(root, ".claude.json"), "utf8"))
        .toBe('{"conversation":"live"}');
      // And no phantom account was registered against the untouched dir.
      expect(mgr.getPrimary("claude")).toBeUndefined();
      expect(fs.existsSync(path.join(root, "provider-accounts", "claude", "claude-default")))
        .toBe(false);
    });

    it("migrates normally when not in a session container", () => {
      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(root, ".claude", ".credentials.json"), '{"token":"orch"}');

      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      mgr.migrateDefaultAccounts();

      expect(mgr.getPrimary("claude")).toBeDefined();
      const moved = path.join(
        root, "provider-accounts", "claude", "claude-default", ".claude", ".credentials.json",
      );
      expect(fs.readFileSync(moved, "utf8")).toBe('{"token":"orch"}');
    });

    /**
     * Copy-then-verify, not rename: the credential must exist at the
     * destination before the source is removed, so an interrupted migration
     * can only ever cost disk — never the only copy of a live credential.
     */
    it("never leaves the credential absent from both paths", () => {
      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(root, ".claude", ".credentials.json"), '{"token":"t"}');

      new ProviderAccountManager({ credentialsDir: root, credentialStore: store })
        .migrateDefaultAccounts();

      const dest = path.join(
        root, "provider-accounts", "claude", "claude-default", ".claude", ".credentials.json",
      );
      const legacy = path.join(root, ".claude", ".credentials.json");
      expect(fs.existsSync(dest) || fs.existsSync(legacy)).toBe(true);
      expect(fs.readFileSync(dest, "utf8")).toBe('{"token":"t"}');
    });
  });

  /**
   * The sweep and the migration run in the same call, so whatever the sweep
   * leaves on disk is an input to the NEXT boot's migration. Boot-to-boot
   * idempotence is therefore the property that matters, and asserting a single
   * boot cannot see a violation of it: the placeholder the sweep used to write
   * unconditionally was read back on boot 2 as pre-account credentials, and a
   * `ready` account with an empty credential root was registered for a user who
   * had never signed in. That row makes `hasAnyAuthForProvider` true (so the UI
   * reports a connected account) and `selectAccountForTurn` prefers it over the
   * reserved API-key route, sending turns to a credential root with nothing in
   * it.
   */
  describe("boot-to-boot idempotence", () => {
    const boot = (): ProviderAccountManager => {
      const mgr = new ProviderAccountManager({
        credentialsDir: root,
        credentialStore: new CredentialStore(root),
      });
      mgr.migrateDefaultAccounts();
      return mgr;
    };

    it("never invents an account on an install that was never signed in", () => {
      boot();
      const second = boot();

      expect(second.list("claude")).toEqual([]);
      expect(second.list("codex")).toEqual([]);
      expect(second.hasAnyAuthForProvider("claude")).toBe(false);
      expect(second.hasAnyAuthForProvider("codex")).toBe(false);
    });

    it("writes no placeholder at all before an account exists", () => {
      boot();

      expect(fs.existsSync(path.join(root, ".claude"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".codex"))).toBe(false);
    });

    // The placeholder is still owed to a migrated install, and re-booting over
    // it must not re-migrate it once the accounts are gone.
    it("does not re-migrate the placeholder left behind after every account is deleted", () => {
      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(root, ".claude", ".credentials.json"), '{"accessToken":"live"}');

      const first = boot();
      expect(first.list("claude").map((a) => a.id)).toEqual(["claude-default"]);
      // The migrated install keeps its placeholder: `/root/.claude` is an
      // image-level symlink to this path.
      expect(fs.readdirSync(path.join(root, ".claude"))).toEqual([]);

      first.delete("claude", "claude-default");
      const second = boot();

      expect(second.list("claude")).toEqual([]);
    });

    // CLI config written through the image-level `/root/.claude.json` symlink is
    // not a credential, and a reserved-route run legitimately produces one.
    it("does not migrate CLI config with no credentials beside it", () => {
      fs.writeFileSync(path.join(root, ".claude.json"), '{"theme":"dark"}');

      expect(boot().list("claude")).toEqual([]);
      // Untouched: it is the CLI's config, and nothing has claimed it.
      expect(fs.existsSync(path.join(root, ".claude.json"))).toBe(true);
    });

    it("does not migrate a zero-byte credentials file", () => {
      fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(root, ".codex", "auth.json"), "");

      expect(boot().list("codex")).toEqual([]);
    });
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

  it("falls back to a healthy secondary account when the primary's auth failed", () => {
    const now = Date.now();
    store.upsertProviderAccount({
      id: "acct_primary", provider: "claude", label: "Personal",
      isPrimary: true, status: "auth_failed", createdAt: now, updatedAt: now,
    });
    store.upsertProviderAccount({
      id: "acct_secondary", provider: "claude", label: "Work",
      isPrimary: false, status: "ready", createdAt: now, updatedAt: now,
    });

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    expect(mgr.selectRouteForTurn("claude")).toEqual({ kind: "account", id: "acct_secondary" });
  });

  it("prefers a healthy secondary account over the API-key fallback (docs/150 req 12)", () => {
    // A connected subscription must never lose a turn to metered Platform API
    // billing just because the *primary* row is broken.
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const now = Date.now();
    store.upsertProviderAccount({
      id: "acct_primary", provider: "claude", label: "Personal",
      isPrimary: true, status: "auth_failed", createdAt: now, updatedAt: now,
    });
    store.upsertProviderAccount({
      id: "acct_secondary", provider: "claude", label: "Work",
      isPrimary: false, status: "ready", createdAt: now, updatedAt: now,
    });

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    expect(mgr.selectRouteForTurn("claude")).toEqual({ kind: "account", id: "acct_secondary" });
  });

  it("still falls back to a reserved route when no stored account is usable", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const now = Date.now();
    store.upsertProviderAccount({
      id: "acct_primary", provider: "claude", label: "Personal",
      isPrimary: true, status: "auth_failed", createdAt: now, updatedAt: now,
    });
    store.upsertProviderAccount({
      id: "acct_secondary", provider: "claude", label: "Work",
      isPrimary: false, status: "unavailable", createdAt: now, updatedAt: now,
    });

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    expect(mgr.selectRouteForTurn("claude")).toEqual({ kind: "reserved", id: "claude-api-key" });
  });

  it("does not count unavailable or failed stored accounts as configured", () => {
    const now = Date.now();
    store.upsertProviderAccount({
      id: "claude-default",
      provider: "claude",
      label: "Primary Anthropic account",
      isPrimary: true,
      status: "auth_failed",
      createdAt: now,
      updatedAt: now,
    });

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    expect(mgr.hasAnyAuthForProvider("claude")).toBe(false);

    process.env.ANTHROPIC_AUTH_TOKEN = "env-token";
    expect(mgr.hasAnyAuthForProvider("claude")).toBe(true);
    expect(mgr.selectRouteForTurn("claude")).toEqual({ kind: "reserved", id: "claude-env-oauth" });
  });

  describe("generated account labels", () => {
    it("names the first account after the provider and numbers the rest", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

      expect(mgr.create("claude").label).toBe("Claude");
      expect(mgr.create("claude").label).toBe("Claude2");
      expect(mgr.create("claude").label).toBe("Claude3");
      // Numbering is per provider — Codex starts over at its own name.
      expect(mgr.create("codex").label).toBe("Codex");
      expect(mgr.create("codex").label).toBe("Codex2");
    });

    it("skips labels already taken, including user-typed ones", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const first = mgr.create("claude", "Work");
      mgr.rename("claude", first.id, "Claude");

      expect(mgr.create("claude").label).toBe("Claude2");
    });

    it("leaves a supplied label alone", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      expect(mgr.create("claude", "Work").label).toBe("Work");
    });
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
      // The code only means anything against a live challenge, so the flow has
      // to be running — submitting into nothing is its own case below.
      mgr.startAccountAuth("claude", account.id);
      mgr.submitAccountCode("claude", account.id, "abc-123");
      expect(claude.codeCalls).toEqual(["abc-123"]);
    });

    // docs/150 — there is one login process per provider, so an auth operation
    // aimed at account A must never act on account B's in-flight flow.
    describe("two accounts of the same provider signing in at once", () => {
      it("refuses a second sign-in while another account owns the flow", () => {
        const { mgr, claude, account } = setup();
        const second = mgr.create("claude", "Work");
        mgr.startAccountAuth("claude", account.id);

        expect(() => mgr.startAccountAuth("claude", second.id)).toThrow(/already signing in/i);
        // The refusal must leave BOTH rows honest: the first still owns the
        // live flow, and the second was never moved to `authenticating`.
        expect(claude.getActiveAccountId()).toBe(account.id);
        expect(mgr.get("claude", second.id)?.status).not.toBe("authenticating");
        expect(claude.startCalls).toHaveLength(1);
      });

      it("re-starting the SAME account's sign-in is allowed (retry on its own row)", () => {
        const { mgr, claude, account } = setup();
        mgr.startAccountAuth("claude", account.id);
        expect(() => mgr.startAccountAuth("claude", account.id)).not.toThrow();
        expect(claude.startCalls).toHaveLength(2);
      });

      it("cancelling one row does not kill another row's in-flight sign-in", () => {
        const { mgr, claude, account } = setup();
        const second = mgr.create("claude", "Work");
        mgr.startAccountAuth("claude", account.id);

        mgr.cancelAccountAuth("claude", second.id);

        // The live flow survives — previously this cancelled it while only
        // resetting `second`, stranding the first row on `authenticating`.
        expect(claude.cancelCalls).toBe(0);
        expect(claude.getActiveAccountId()).toBe(account.id);
        expect(mgr.get("claude", account.id)?.status).toBe("authenticating");
      });

      it("cancelling the owning row does kill the flow", () => {
        const { mgr, claude, account } = setup();
        mgr.startAccountAuth("claude", account.id);
        mgr.cancelAccountAuth("claude", account.id);
        expect(claude.cancelCalls).toBe(1);
        expect(claude.getActiveAccountId()).toBeNull();
      });

      // The nastiest shape of this bug: the row that owns the flow is deleted,
      // so the scope it holds can never be released from the UI — there is no
      // row left to press Cancel on — and the guard then refuses every future
      // sign-in for the provider.
      it("deleting the row that owns the flow releases the provider", () => {
        const { mgr, claude, account } = setup();
        mgr.startAccountAuth("claude", account.id);
        expect(claude.getActiveAccountId()).toBe(account.id);

        mgr.delete("claude", account.id);

        expect(claude.cancelCalls).toBe(1);
        expect(claude.getActiveAccountId()).toBeNull();
        // And a fresh account can sign in rather than hitting a phantom owner.
        const replacement = mgr.create("claude", "Replacement");
        expect(() => mgr.startAccountAuth("claude", replacement.id)).not.toThrow();
      });

      it("deleting an unrelated row leaves the in-flight sign-in alone", () => {
        const { mgr, claude, account } = setup();
        const second = mgr.create("claude", "Work");
        mgr.startAccountAuth("claude", account.id);

        mgr.delete("claude", second.id);

        expect(claude.cancelCalls).toBe(0);
        expect(claude.getActiveAccountId()).toBe(account.id);
      });

      // A row stuck on `authenticating` blocks every other account, so a
      // sign-in that never started must not leave one behind.
      it("puts the row back when the login process fails to start", () => {
        const { mgr, claude, account } = setup();
        claude.startShouldThrow = new Error("spawn ENOENT");

        expect(() => mgr.startAccountAuth("claude", account.id)).toThrow(/spawn ENOENT/);

        expect(mgr.get("claude", account.id)?.status).toBe("unavailable");
        // ...and the provider is still usable by anyone else.
        const second = mgr.create("claude", "Work");
        claude.startShouldThrow = null;
        expect(() => mgr.startAccountAuth("claude", second.id)).not.toThrow();
      });

      it("refuses a pasted code when no sign-in is running at all", () => {
        const { mgr, claude, account } = setup();
        // Timed out, cancelled, or lost to a restart. Previously the manager
        // logged and dropped it while the endpoint answered 200.
        expect(() => mgr.submitAccountCode("claude", account.id, "abc-123")).toThrow(/no longer running/i);
        expect(claude.codeCalls).toEqual([]);
      });

      it("refuses a code pasted on a row that does not own the flow", () => {
        const { mgr, claude, account } = setup();
        const second = mgr.create("claude", "Work");
        mgr.startAccountAuth("claude", account.id);

        // The code belongs to the challenge that issued it; submitting it here
        // would authenticate the wrong account.
        expect(() => mgr.submitAccountCode("claude", second.id, "abc-123")).toThrow(/already signing in/i);
        expect(claude.codeCalls).toEqual([]);
      });
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

    /**
     * req 19 — provider-wide sign-out used to delete the account *rows* and
     * clear only the singleton path. On a migrated install that path aliased
     * `<provider>-default`, so one account's credentials were erased and every
     * account connected afterwards kept live OAuth tokens on disk with no row
     * left to reach them from: "Sign out of Claude" left the tokens behind.
     */
    it("signOutProvider erases every account's credentials, not just the migrated default", () => {
      const { mgr, claude, account } = setup();
      const second = mgr.create("claude", "Work");
      for (const id of [account.id, second.id]) {
        const dir = path.join(mgr.resolveCredentialRoot("claude", id), ".claude");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, ".credentials.json"), "{}");
      }

      mgr.signOutProvider("claude");

      expect(mgr.list("claude")).toEqual([]);
      for (const id of [account.id, second.id]) {
        expect(fs.existsSync(mgr.resolveCredentialRoot("claude", id))).toBe(false);
      }
      // The unscoped sign-out still runs, for installs that never migrated.
      expect(claude.signOutCalls).toContainEqual({});
    });

    it("signOutProvider ends an in-flight login on an account it is deleting", () => {
      const { mgr, claude, account } = setup();
      mgr.startAccountAuth("claude", account.id);
      expect(claude.getActiveAccountId()).toBe(account.id);

      mgr.signOutProvider("claude");

      expect(claude.getActiveAccountId()).toBeNull();
    });

    it("scoped-auth methods throw a clear error when no auth managers are wired", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const account = mgr.create("claude");
      expect(() => mgr.startAccountAuth("claude", account.id)).toThrow(/no auth manager wired/i);
    });
  });

  /**
   * docs/150 req 7 — hard exhaustion has to be *persisted*, not inferred from
   * the live quota snapshot: that snapshot is telemetry, and it can lag the
   * failure, report a null percentage below a warning threshold, or not exist
   * at all for a freshly connected account.
   */
  describe("markAccountExhausted (docs/150 req 7)", () => {
    it("benches the account so the router stops choosing it", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("claude", "A");
      const b = mgr.create("claude", "B");
      mgr.setAccountStatus("claude", a.id, "ready");
      mgr.setAccountStatus("claude", b.id, "ready");
      // No quota snapshot at all — the stamp is the only signal there is.
      expect(mgr.selectAccountForTurn("claude")).toEqual({ ok: true, route: { kind: "account", id: a.id } });

      const until = Date.now() + 3_600_000;
      mgr.markAccountExhausted("claude", a.id, until);

      expect(mgr.isRouteUsableForTurn("claude", { kind: "account", id: a.id })).toBe(false);
      expect(mgr.selectAccountForTurn("claude")).toEqual({ ok: true, route: { kind: "account", id: b.id } });
    });

    it("persists across manager instances (a restart must not un-bench it)", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("claude", "A");
      mgr.setAccountStatus("claude", a.id, "ready");
      const until = Date.now() + 3_600_000;
      mgr.markAccountExhausted("claude", a.id, until);

      const reloaded = new ProviderAccountManager({
        credentialsDir: root,
        credentialStore: new CredentialStore(root),
      });
      expect(reloaded.isRouteUsableForTurn("claude", { kind: "account", id: a.id })).toBe(false);
    });

    it("expires on its own, so a lockout can never outlive its reset", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("claude", "A");
      mgr.setAccountStatus("claude", a.id, "ready");
      mgr.markAccountExhausted("claude", a.id, Date.now() - 1_000);

      expect(mgr.isRouteUsableForTurn("claude", { kind: "account", id: a.id })).toBe(true);
    });

    // A later failure carrying a vaguer reset must not shorten a lockout the
    // provider already told us the true end of.
    it("only ever extends an existing lockout", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("claude", "A");
      mgr.setAccountStatus("claude", a.id, "ready");
      const far = Date.now() + 7_200_000;
      mgr.markAccountExhausted("claude", a.id, far);
      mgr.markAccountExhausted("claude", a.id, Date.now() + 60_000);

      expect(mgr.get("claude", a.id)?.exhaustedUntil).toBe(far);
    });

    it("ignores an unknown account rather than inventing a row", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      expect(mgr.markAccountExhausted("claude", "acct_nope", Date.now() + 1000)).toBeNull();
      expect(mgr.list("claude")).toEqual([]);
    });
  });

  /**
   * docs/150 req 2 — the user-controlled fallback order. Reqs 4-6 and 3 all say
   * failover advances "to the next eligible account in the user's priority
   * order", so this is what those mean by order.
   */
  describe("priority order (docs/150 req 2)", () => {
    function threeReady(): { mgr: ProviderAccountManager; ids: string[] } {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const ids = ["A", "B", "C"].map((label) => {
        const account = mgr.create("claude", label);
        mgr.setAccountStatus("claude", account.id, "ready");
        return account.id;
      });
      return { mgr, ids };
    }

    it("selects in the user's order, not creation order", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("claude", [ids[2]!, ids[0]!, ids[1]!]);

      expect(mgr.accountsInSelectionOrder("claude").map((a) => a.id)).toEqual([ids[2], ids[0], ids[1]]);
      expect(mgr.selectAccountForTurn("claude")).toEqual({ ok: true, route: { kind: "account", id: ids[2] } });
    });

    // The bug the reorder buttons actually had: `reorder` wrote `priority`
    // correctly and the ROUTER honoured it, but everything the client sees —
    // the PUT response, the `provider_accounts` broadcast, bootstrap — reads
    // `list()`, which returned raw storage order. `upsertProviderAccount`
    // replaces in place, so storage order never moves: the rows stayed put and
    // the control read as broken while routing silently changed underneath.
    // Asserting `accountsInSelectionOrder` alone never caught it, because that
    // was the one accessor that was always right.
    it("exposes the user's order through list(), which is what the client renders", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("claude", [ids[2]!, ids[0]!, ids[1]!]);

      expect(mgr.list("claude").map((a) => a.id)).toEqual([ids[2], ids[0], ids[1]]);
      // And through the all-providers form the SSE broadcast uses.
      expect(mgr.list().filter((a) => a.provider === "claude").map((a) => a.id))
        .toEqual([ids[2], ids[0], ids[1]]);
    });

    it("survives a restart", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("claude", [ids[1]!, ids[2]!, ids[0]!]);

      const reloaded = new ProviderAccountManager({
        credentialsDir: root,
        credentialStore: new CredentialStore(root),
      });
      expect(reloaded.accountsInSelectionOrder("claude").map((a) => a.id)).toEqual([ids[1], ids[2], ids[0]]);
    });

    // Otherwise connecting an account would silently change which subscription
    // existing work runs on.
    it("appends a newly connected account rather than inserting it", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("claude", [ids[2]!, ids[0]!, ids[1]!]);
      const fresh = mgr.create("claude", "D");
      mgr.setAccountStatus("claude", fresh.id, "ready");

      expect(mgr.accountsInSelectionOrder("claude").map((a) => a.id)).toEqual([ids[2], ids[0], ids[1], fresh.id]);
      expect(mgr.selectAccountForTurn("claude")).toEqual({ ok: true, route: { kind: "account", id: ids[2] } });
    });

    it("keeps isPrimary in step with position 0 so the two cannot disagree", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("claude", [ids[1]!, ids[0]!, ids[2]!]);

      expect(mgr.get("claude", ids[1]!)?.isPrimary).toBe(true);
      expect(mgr.get("claude", ids[0]!)?.isPrimary).toBe(false);
      expect(mgr.getPrimary("claude")?.id).toBe(ids[1]);
    });

    it("promotes to the front via makePrimary without disturbing the rest", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("claude", [ids[0]!, ids[1]!, ids[2]!]);
      mgr.makePrimary("claude", ids[2]!);

      expect(mgr.accountsInSelectionOrder("claude").map((a) => a.id)).toEqual([ids[2], ids[0], ids[1]]);
    });

    // A stale client — one whose list predates an account added in another tab
    // — must fail loudly rather than quietly demoting the account it never saw.
    it("rejects a partial, duplicated, or foreign order", () => {
      const { mgr, ids } = threeReady();
      expect(() => mgr.reorder("claude", [ids[0]!, ids[1]!])).toThrow(/exactly once/);
      expect(() => mgr.reorder("claude", [ids[0]!, ids[0]!, ids[1]!])).toThrow(/duplicates/);
      expect(() => mgr.reorder("claude", [ids[0]!, ids[1]!, "acct_nope"])).toThrow(/exactly once/);
      // Nothing was written on any of the rejected calls.
      expect(mgr.accountsInSelectionOrder("claude").map((a) => a.id)).toEqual(ids);
    });

    // Rows written before `priority` existed must keep behaving exactly as they
    // did, or an upgrade would silently move which account turns run on. That
    // used to be a read-time fallback; docs/150 req 19 replaces it with a
    // one-time backfill, so the guarantee is asserted against the backfill.
    const stripPriority = (mgr: ProviderAccountManager, ids: string[], primaryId: string): void => {
      for (const id of ids) {
        const account = mgr.get("claude", id)!;
        const { priority: _dropped, ...legacy } = account;
        store.upsertProviderAccount({ ...legacy, isPrimary: id === primaryId });
      }
    };

    it("backfills priority from the order legacy rows already resolved to", () => {
      const { mgr, ids } = threeReady();
      stripPriority(mgr, ids as string[], ids[1]!);

      mgr.backfillPriority();

      // Same order the old primary-then-stored-order rule produced.
      expect(mgr.list("claude").map((a) => a.id)).toEqual([ids[1], ids[0], ids[2]]);
      expect(mgr.list("claude").map((a) => a.priority)).toEqual([0, 1, 2]);
      // And it is now recorded, so the legacy rule is never needed again.
      expect(store.listProviderAccounts("claude").every((a) => typeof a.priority === "number")).toBe(true);
    });

    it("backfill is idempotent and does not disturb an explicit order", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("claude", [ids[2]!, ids[0]!, ids[1]!]);

      mgr.backfillPriority();
      mgr.backfillPriority();

      expect(mgr.list("claude").map((a) => a.id)).toEqual([ids[2], ids[0], ids[1]]);
    });

    // req 19 — one fact, one field. `isPrimary` is position 0, always.
    it("derives isPrimary from position rather than the stored flag", () => {
      const { mgr, ids } = threeReady();
      // Poison the stored flag: claim the LAST row is primary.
      const last = mgr.get("claude", ids[2]!)!;
      store.upsertProviderAccount({ ...last, isPrimary: true });

      const rows = mgr.list("claude");
      expect(rows.map((a) => a.isPrimary)).toEqual([true, false, false]);
      expect(rows[0]!.id).toBe(ids[0]);
      // Every accessor agrees — a caller must not get a different answer
      // depending on which one it reached for.
      expect(mgr.get("claude", ids[0]!)?.isPrimary).toBe(true);
      expect(mgr.get("claude", ids[2]!)?.isPrimary).toBe(false);
      expect(mgr.getPrimary("claude")?.id).toBe(ids[0]);
    });

    it("moves the primary badge with the order", () => {
      const { mgr, ids } = threeReady();
      expect(mgr.getPrimary("claude")?.id).toBe(ids[0]);

      mgr.makePrimary("claude", ids[2]!);

      expect(mgr.getPrimary("claude")?.id).toBe(ids[2]);
      expect(mgr.list("claude").map((a) => a.isPrimary)).toEqual([true, false, false]);
    });
  });

  /**
   * docs/150 reqs 4-6 — the proactive cutoff. The load-bearing property is that
   * a cutoff is a PREFERENCE, not a wall: crossing it demotes an account, it
   * does not make it unusable. Collapsing the two would make a 90% setting
   * strictly worse than no failover at all.
   */
  describe("proactive failover cutoffs (docs/150 reqs 4-6)", () => {
    const win = (usedPct: number | null) => ({
      usedPct,
      resetAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    function mgrWith(limits: Record<string, { session?: unknown; weekly?: unknown }>): ProviderAccountManager {
      return new ProviderAccountManager({
        credentialsDir: root,
        credentialStore: store,
        getSubscriptionLimits: () => ({ claude: limits as never }),
      });
    }

    function twoReadyAccounts(): { a: string; b: string } {
      const seed = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = seed.create("claude", "A");
      const b = seed.create("claude", "B");
      seed.setAccountStatus("claude", a.id, "ready");
      seed.setAccountStatus("claude", b.id, "ready");
      return { a: a.id, b: b.id };
    }

    it("defaults both cutoffs to 90% (req 5)", () => {
      expect(store.getFailoverCutoffs("claude")).toEqual({ session: 90, weekly: 90 });
    });

    it("moves new work off an account past the short-window cutoff (req 6)", () => {
      const { a, b } = twoReadyAccounts();
      const mgr = mgrWith({ [a]: { session: win(92) }, [b]: { session: win(10) } });

      expect(mgr.selectAccountForTurn("claude")).toEqual({ ok: true, route: { kind: "account", id: b } });
    });

    it("moves new work off an account past the weekly cutoff too (req 4)", () => {
      const { a, b } = twoReadyAccounts();
      const mgr = mgrWith({ [a]: { session: win(10), weekly: win(95) }, [b]: { session: win(10) } });

      expect(mgr.selectAccountForTurn("claude")).toEqual({ ok: true, route: { kind: "account", id: b } });
    });

    // The whole point of the three-tier split. At 92% an account still has 8%
    // of its window left; failing the turn would waste it.
    it("still uses an over-cutoff account when every account is over its cutoff", () => {
      const { a, b } = twoReadyAccounts();
      const mgr = mgrWith({ [a]: { session: win(92) }, [b]: { session: win(97) } });

      expect(mgr.selectAccountForTurn("claude")).toEqual({ ok: true, route: { kind: "account", id: a } });
    });

    it("still reports all_exhausted when accounts are genuinely spent, not merely over cutoff", () => {
      const { a, b } = twoReadyAccounts();
      const mgr = mgrWith({ [a]: { session: win(100) }, [b]: { session: win(100) } });

      expect(mgr.selectAccountForTurn("claude")).toMatchObject({ ok: false, reason: "all_exhausted" });
    });

    it("honours a configured cutoff instead of the default", () => {
      const { a, b } = twoReadyAccounts();
      store.setFailoverCutoffs("claude", { session: 50 });
      const mgr = mgrWith({ [a]: { session: win(60) }, [b]: { session: win(10) } });

      expect(mgr.selectAccountForTurn("claude")).toEqual({ ok: true, route: { kind: "account", id: b } });
    });

    // Claude reports usedPct only above a warning threshold, so silence must
    // not read as "past 90%" — that would demote every healthy account.
    it("treats an unreported percentage as under the cutoff", () => {
      const { a } = twoReadyAccounts();
      const mgr = mgrWith({ [a]: { session: win(null) } });

      expect(mgr.selectAccountForTurn("claude")).toEqual({ ok: true, route: { kind: "account", id: a } });
    });

    describe("isRouteUsableForTurn", () => {
      it("displaces a pinned session that is over its cutoff when a better account exists (reqs 6, 8)", () => {
        const { a, b } = twoReadyAccounts();
        const mgr = mgrWith({ [a]: { session: win(92) }, [b]: { session: win(10) } });

        expect(mgr.isRouteUsableForTurn("claude", { kind: "account", id: a })).toBe(false);
      });

      // Without this, `failoverPinnedSession` would hand the session a
      // different over-cutoff account every turn, killing the resident process
      // each time for no benefit.
      it("leaves a pinned session alone when every account is over its cutoff (no churn)", () => {
        const { a, b } = twoReadyAccounts();
        const mgr = mgrWith({ [a]: { session: win(92) }, [b]: { session: win(97) } });

        expect(mgr.isRouteUsableForTurn("claude", { kind: "account", id: a })).toBe(true);
        expect(mgr.isRouteUsableForTurn("claude", { kind: "account", id: b })).toBe(true);
      });

      it("still reports a genuinely spent account as unusable", () => {
        const { a, b } = twoReadyAccounts();
        const mgr = mgrWith({ [a]: { session: win(100) }, [b]: { session: win(100) } });

        expect(mgr.isRouteUsableForTurn("claude", { kind: "account", id: a })).toBe(false);
      });
    });

    // docs/150 reqs 6, 7, 11 — the notice the user reads depends on *which*
    // of these happened, so the three must not collapse into one another.
    describe("classifyRouteForTurn", () => {
      it("separates a cutoff from real exhaustion", () => {
        const { a, b } = twoReadyAccounts();
        const overCutoff = mgrWith({ [a]: { session: win(92) }, [b]: { session: win(10) } });
        const spent = mgrWith({ [a]: { session: win(100) }, [b]: { session: win(10) } });

        expect(overCutoff.classifyRouteForTurn("claude", { kind: "account", id: a })).toBe("over_cutoff");
        expect(spent.classifyRouteForTurn("claude", { kind: "account", id: a })).toBe("exhausted");
      });

      it("reports a disconnected or signed-out account as unavailable, not out of quota", () => {
        const { a } = twoReadyAccounts();
        const mgr = mgrWith({});
        mgr.setAccountStatus("claude", a, "auth_failed");

        expect(mgr.classifyRouteForTurn("claude", { kind: "account", id: a })).toBe("unavailable");
        expect(mgr.classifyRouteForTurn("claude", { kind: "account", id: "acct_gone" })).toBe("unavailable");
      });

      it("agrees with isRouteUsableForTurn — null exactly when usable", () => {
        const { a, b } = twoReadyAccounts();
        const mgr = mgrWith({ [a]: { session: win(10) }, [b]: { session: win(10) } });

        expect(mgr.classifyRouteForTurn("claude", { kind: "account", id: a })).toBeNull();
        expect(mgr.isRouteUsableForTurn("claude", { kind: "account", id: a })).toBe(true);
        // A reserved route has no subscription window to leave (req 12).
        expect(mgr.classifyRouteForTurn("claude", { kind: "reserved", id: "claude-api-key" })).toBeNull();
      });
    });
  });

  describe("selectAccountForTurn (docs/150 reqs 13, 14, 17)", () => {
    const READY = "ready" as const;

    function withLimits(
      root: string,
      store: CredentialStore,
      limits: Record<string, { session?: { usedPct: number | null; resetAt: string } | null }>,
    ): ProviderAccountManager {
      return new ProviderAccountManager({
        credentialsDir: root,
        credentialStore: store,
        getSubscriptionLimits: () => ({ claude: limits as never }),
      });
    }

    it("skips an exhausted account and picks the next one with quota", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("claude", "A");
      const b = mgr.create("claude", "B");
      mgr.setAccountStatus("claude", a.id, READY);
      mgr.setAccountStatus("claude", b.id, READY);

      const quota = withLimits(root, store, {
        [a.id]: { session: { usedPct: 100, resetAt: new Date(Date.now() + 3_600_000).toISOString() } },
        [b.id]: { session: { usedPct: 20, resetAt: new Date(Date.now() + 3_600_000).toISOString() } },
      });

      expect(quota.selectAccountForTurn("claude")).toEqual({
        ok: true,
        route: { kind: "account", id: b.id },
      });
    });

    it("reports all_exhausted with the soonest reset when every account is spent (req 13)", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("claude", "A");
      const b = mgr.create("claude", "B");
      mgr.setAccountStatus("claude", a.id, READY);
      mgr.setAccountStatus("claude", b.id, READY);

      const later = new Date(Date.now() + 7_200_000).toISOString();
      const sooner = new Date(Date.now() + 1_800_000).toISOString();
      const quota = withLimits(root, store, {
        [a.id]: { session: { usedPct: 100, resetAt: later } },
        [b.id]: { session: { usedPct: 100, resetAt: sooner } },
      });

      expect(quota.selectAccountForTurn("claude")).toEqual({
        ok: false,
        reason: "all_exhausted",
        earliestResetAt: sooner,
      });
    });

    it("never fails over onto metered API billing (req 12)", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("claude", "A");
      mgr.setAccountStatus("claude", a.id, READY);
      const quota = withLimits(root, store, {
        [a.id]: { session: { usedPct: 100, resetAt: new Date(Date.now() + 3_600_000).toISOString() } },
      });

      // The reserved API-key route exists, but an exhausted *subscription* must
      // not silently spend pay-as-you-go money.
      const selection = quota.selectAccountForTurn("claude");
      expect(selection.ok).toBe(false);
    });

    it("treats unknown quota as usable rather than locking out a fresh account", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("claude", "A");
      mgr.setAccountStatus("claude", a.id, READY);
      // Claude reports no usedPct below its warning threshold; Codex reports
      // nothing until a turn has run.
      const quota = withLimits(root, store, { [a.id]: { session: { usedPct: null, resetAt: "x" } } });

      expect(quota.selectAccountForTurn("claude")).toEqual({
        ok: true,
        route: { kind: "account", id: a.id },
      });
    });

    it("ignores an exhausted window whose reset has already passed", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("claude", "A");
      mgr.setAccountStatus("claude", a.id, READY);
      const quota = withLimits(root, store, {
        [a.id]: { session: { usedPct: 100, resetAt: new Date(Date.now() - 60_000).toISOString() } },
      });

      expect(quota.selectAccountForTurn("claude").ok).toBe(true);
    });

    it("excludes a route that already failed this turn (req 14)", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("claude", "A");
      const b = mgr.create("claude", "B");
      mgr.setAccountStatus("claude", a.id, READY);
      mgr.setAccountStatus("claude", b.id, READY);

      expect(mgr.selectAccountForTurn("claude", { exclude: [a.id] })).toEqual({
        ok: true,
        route: { kind: "account", id: b.id },
      });
    });



    it("reports auth_required when nothing is connected", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      expect(mgr.selectAccountForTurn("claude")).toEqual({ ok: false, reason: "auth_required" });
    });

    it("keeps a persisted exhaustedUntil out of the running until it lapses (req 7)", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("claude", "A");
      const b = mgr.create("claude", "B");
      mgr.setAccountStatus("claude", a.id, READY);
      mgr.setAccountStatus("claude", b.id, READY);
      // Hard exhaustion reported mid-turn, before any new snapshot arrives.
      store.upsertProviderAccount({
        ...mgr.list("claude").find((x) => x.id === a.id)!,
        exhaustedUntil: Date.now() + 3_600_000,
      });

      expect(mgr.selectAccountForTurn("claude")).toEqual({
        ok: true,
        route: { kind: "account", id: b.id },
      });
    });
  });
});
