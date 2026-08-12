import { REFUSAL_REPROBE_MS, refusalBlockedUntil } from "../shared/types/domain-types/credential-route.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credential-store.js";
import { accountServiceForHarness, ProviderAccountManager } from "./provider-account-manager.js";
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

  it("quarantines distinct Claude rows that contain the same OAuth token", () => {
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    const first = mgr.create("anthropic", "Claude 1");
    const second = mgr.create("anthropic", "Claude 2");
    const writeToken = (id: string, token: string, filename = ".credentials.json") => {
      const dir = path.join(mgr.resolveCredentialRoot("claude", id), ".claude");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, filename),
        JSON.stringify({ claudeAiOauth: { accessToken: token } }),
      );
      mgr.setAccountStatus("anthropic", id, "ready");
    };
    writeToken(first.id, "shared-token");
    writeToken(second.id, "shared-token", "auth.json");

    expect(mgr.quarantineDuplicateClaudeCredentials()).toEqual([[first.id, second.id]]);
    expect(mgr.get("anthropic", first.id)?.status).toBe("auth_failed");
    expect(mgr.get("anthropic", second.id)?.status).toBe("auth_failed");
  });

  it("does not quarantine independent Claude account tokens", () => {
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    const first = mgr.create("anthropic", "Claude 1");
    const second = mgr.create("anthropic", "Claude 2");
    for (const [id, token] of [[first.id, "token-a"], [second.id, "token-b"]]) {
      const dir = path.join(mgr.resolveCredentialRoot("claude", id), ".claude");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: token } }),
      );
      mgr.setAccountStatus("anthropic", id, "ready");
    }

    expect(mgr.quarantineDuplicateClaudeCredentials()).toEqual([]);
    expect(mgr.list("anthropic").map((account) => account.status)).toEqual(["ready", "ready"]);
  });

  it("migrates legacy Claude credentials into a primary default account", () => {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", ".credentials.json"), "{}");
    fs.writeFileSync(path.join(root, ".claude.json"), "{}");

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    mgr.migrateDefaultAccounts();

    const account = mgr.getPrimary("anthropic");
    expect(account).toMatchObject({
      id: "claude-default",
      serviceId: "anthropic", billingMode: "sub", via: "account",
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
    store.upsertCredentialRoute({
      id: "claude-default", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Primary Anthropic account",
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
    store.upsertCredentialRoute({
      id: "acct_other", serviceId: "openai", billingMode: "sub", via: "account", label: "Work",
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
      store.upsertCredentialRoute({
        id: "acct_other", serviceId: "openai", billingMode: "sub", via: "account", label: "Work",
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
      expect(mgr.getPrimary("anthropic")).toBeUndefined();
      expect(fs.existsSync(path.join(root, "provider-accounts", "claude", "claude-default")))
        .toBe(false);
    });

    it("migrates normally when not in a session container", () => {
      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(root, ".claude", ".credentials.json"), '{"token":"orch"}');

      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      mgr.migrateDefaultAccounts();

      expect(mgr.getPrimary("anthropic")).toBeDefined();
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

      expect(second.list("anthropic")).toEqual([]);
      expect(second.list("openai")).toEqual([]);
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
      expect(first.list("anthropic").map((a) => a.id)).toEqual(["claude-default"]);
      // The migrated install keeps its placeholder: `/root/.claude` is an
      // image-level symlink to this path.
      expect(fs.readdirSync(path.join(root, ".claude"))).toEqual([]);

      first.delete("anthropic", "claude-default");
      const second = boot();

      expect(second.list("anthropic")).toEqual([]);
    });

    // CLI config written through the image-level `/root/.claude.json` symlink is
    // not a credential, and a reserved-route run legitimately produces one.
    it("does not migrate CLI config with no credentials beside it", () => {
      fs.writeFileSync(path.join(root, ".claude.json"), '{"theme":"dark"}');

      expect(boot().list("anthropic")).toEqual([]);
      // Untouched: it is the CLI's config, and nothing has claimed it.
      expect(fs.existsSync(path.join(root, ".claude.json"))).toBe(true);
    });

    it("does not migrate a zero-byte credentials file", () => {
      fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(root, ".codex", "auth.json"), "");

      expect(boot().list("openai")).toEqual([]);
    });
  });

  /**
   * planning#342 — the manager's row verbs are keyed by **catalogue service**,
   * and a harness id is a bare string too, so `list("claude")` compiles.
   *
   * Pinned because it is the one transposition the compiler cannot catch, and
   * because its symptom is silence: an empty list reads as "no accounts
   * connected", which is a perfectly ordinary state. `accountServiceForHarness`
   * is the conversion every caller holding an `AgentId` must go through.
   */
  it("answers a harness id with nothing — the axis is the service", () => {
    const now = Date.now();
    store.upsertCredentialRoute({
      id: "acct_1",
      serviceId: "anthropic", billingMode: "sub", via: "account",
      label: "Work", isPrimary: false, status: "ready", createdAt: now, updatedAt: now,
    });
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    expect(mgr.list("claude")).toEqual([]);
    expect(mgr.list(accountServiceForHarness("claude")).map((a) => a.id)).toEqual(["acct_1"]);
    expect(accountServiceForHarness("codex")).toBe("openai");
  });

  it("does not create an account when only reserved env auth exists", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "token";

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    mgr.migrateDefaultAccounts();

    expect(mgr.list("anthropic")).toEqual([]);
    expect(mgr.hasAnyAuthForProvider("claude")).toBe(true);
    expect(mgr.selectRouteForTurn("anthropic")).toEqual({ kind: "reserved", id: "claude-env-oauth" });
  });

  it("selects the primary stored account before API-key fallbacks", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const now = Date.now();
    store.upsertCredentialRoute({
      id: "codex-default",
      serviceId: "openai", billingMode: "sub", via: "account",
      label: "Primary ChatGPT account",
      isPrimary: true,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    });

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    expect(mgr.hasAnyAuthForProvider("codex")).toBe(true);
    expect(mgr.selectRouteForTurn("openai")).toEqual({ kind: "account", id: "codex-default" });
  });

  it("falls back to a healthy secondary account when the primary's auth failed", () => {
    const now = Date.now();
    store.upsertCredentialRoute({
      id: "acct_primary", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Personal",
      isPrimary: true, status: "auth_failed", createdAt: now, updatedAt: now,
    });
    store.upsertCredentialRoute({
      id: "acct_secondary", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work",
      isPrimary: false, status: "ready", createdAt: now, updatedAt: now,
    });

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    expect(mgr.selectRouteForTurn("anthropic")).toEqual({ kind: "account", id: "acct_secondary" });
  });

  it("prefers a healthy secondary account over the API-key fallback (docs/150 req 12)", () => {
    // A connected subscription must never lose a turn to metered Platform API
    // billing just because the *primary* row is broken.
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const now = Date.now();
    store.upsertCredentialRoute({
      id: "acct_primary", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Personal",
      isPrimary: true, status: "auth_failed", createdAt: now, updatedAt: now,
    });
    store.upsertCredentialRoute({
      id: "acct_secondary", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work",
      isPrimary: false, status: "ready", createdAt: now, updatedAt: now,
    });

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    expect(mgr.selectRouteForTurn("anthropic")).toEqual({ kind: "account", id: "acct_secondary" });
  });

  it("still falls back to a reserved route when no stored account is usable", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const now = Date.now();
    store.upsertCredentialRoute({
      id: "acct_primary", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Personal",
      isPrimary: true, status: "auth_failed", createdAt: now, updatedAt: now,
    });
    store.upsertCredentialRoute({
      id: "acct_secondary", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work",
      isPrimary: false, status: "unavailable", createdAt: now, updatedAt: now,
    });

    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

    expect(mgr.selectRouteForTurn("anthropic")).toEqual({ kind: "reserved", id: "claude-api-key" });
  });

  it("does not count unavailable or failed stored accounts as configured", () => {
    const now = Date.now();
    store.upsertCredentialRoute({
      id: "claude-default",
      serviceId: "anthropic", billingMode: "sub", via: "account",
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
    expect(mgr.selectRouteForTurn("anthropic")).toEqual({ kind: "reserved", id: "claude-env-oauth" });
  });

  describe("generated account labels", () => {
    it("names the first account after the provider and numbers the rest", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });

      expect(mgr.create("anthropic").label).toBe("Claude");
      expect(mgr.create("anthropic").label).toBe("Claude2");
      expect(mgr.create("anthropic").label).toBe("Claude3");
      // Numbering is per provider — Codex starts over at its own name.
      expect(mgr.create("openai").label).toBe("Codex");
      expect(mgr.create("openai").label).toBe("Codex2");
    });

    it("skips labels already taken, including user-typed ones", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const first = mgr.create("anthropic", "Work");
      mgr.rename("anthropic", first.id, "Claude");

      expect(mgr.create("anthropic").label).toBe("Claude2");
    });

    it("leaves a supplied label alone", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      expect(mgr.create("anthropic", "Work").label).toBe("Work");
    });
  });

  describe("account-scoped auth flows (docs/150)", () => {
    function setup() {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const claude = new FakeAuthManager("claude");
      const codex = new FakeAuthManager("codex");
      mgr.attachAuthManagers(new Map([["claude", claude], ["codex", codex]]));
      const account = mgr.create("anthropic", "Work");
      return { mgr, claude, codex, account };
    }

    it("startAccountAuth marks the row authenticating and drives the manager with the account credential root", () => {
      const { mgr, claude, account } = setup();
      const result = mgr.startAccountAuth("anthropic", account.id);

      expect(result.status).toBe("authenticating");
      expect(mgr.get("anthropic", account.id)?.status).toBe("authenticating");
      expect(claude.startCalls).toHaveLength(1);
      expect(claude.startCalls[0]).toEqual({
        accountId: account.id,
        credentialDir: mgr.resolveCredentialRoot("claude", account.id),
      });
    });

    it("cancelAccountAuth resets status from the on-disk credential check", () => {
      const { mgr, claude, account } = setup();
      mgr.startAccountAuth("anthropic", account.id);

      claude.configured = false;
      expect(mgr.cancelAccountAuth("anthropic", account.id).status).toBe("unavailable");
      expect(claude.cancelCalls).toBe(1);

      mgr.startAccountAuth("anthropic", account.id);
      claude.configured = true;
      expect(mgr.cancelAccountAuth("anthropic", account.id).status).toBe("ready");
    });

    it("submitAccountCode delegates to the manager's submitCode", () => {
      const { mgr, claude, account } = setup();
      // The code only means anything against a live challenge, so the flow has
      // to be running — submitting into nothing is its own case below.
      mgr.startAccountAuth("anthropic", account.id);
      mgr.submitAccountCode("anthropic", account.id, "abc-123");
      expect(claude.codeCalls).toEqual(["abc-123"]);
    });

    // docs/150 — there is one login process per provider, so an auth operation
    // aimed at account A must never act on account B's in-flight flow.
    describe("two accounts of the same provider signing in at once", () => {
      it("refuses a second sign-in while another account owns the flow", () => {
        const { mgr, claude, account } = setup();
        const second = mgr.create("anthropic", "Work");
        mgr.startAccountAuth("anthropic", account.id);

        expect(() => mgr.startAccountAuth("anthropic", second.id)).toThrow(/already signing in/i);
        // The refusal must leave BOTH rows honest: the first still owns the
        // live flow, and the second was never moved to `authenticating`.
        expect(claude.getActiveAccountId()).toBe(account.id);
        expect(mgr.get("anthropic", second.id)?.status).not.toBe("authenticating");
        expect(claude.startCalls).toHaveLength(1);
      });

      it("re-starting the SAME account's sign-in is allowed (retry on its own row)", () => {
        const { mgr, claude, account } = setup();
        mgr.startAccountAuth("anthropic", account.id);
        expect(() => mgr.startAccountAuth("anthropic", account.id)).not.toThrow();
        expect(claude.startCalls).toHaveLength(2);
      });

      it("cancelling one row does not kill another row's in-flight sign-in", () => {
        const { mgr, claude, account } = setup();
        const second = mgr.create("anthropic", "Work");
        mgr.startAccountAuth("anthropic", account.id);

        mgr.cancelAccountAuth("anthropic", second.id);

        // The live flow survives — previously this cancelled it while only
        // resetting `second`, stranding the first row on `authenticating`.
        expect(claude.cancelCalls).toBe(0);
        expect(claude.getActiveAccountId()).toBe(account.id);
        expect(mgr.get("anthropic", account.id)?.status).toBe("authenticating");
      });

      it("cancelling the owning row does kill the flow", () => {
        const { mgr, claude, account } = setup();
        mgr.startAccountAuth("anthropic", account.id);
        mgr.cancelAccountAuth("anthropic", account.id);
        expect(claude.cancelCalls).toBe(1);
        expect(claude.getActiveAccountId()).toBeNull();
      });

      // The nastiest shape of this bug: the row that owns the flow is deleted,
      // so the scope it holds can never be released from the UI — there is no
      // row left to press Cancel on — and the guard then refuses every future
      // sign-in for the provider.
      it("deleting the row that owns the flow releases the provider", () => {
        const { mgr, claude, account } = setup();
        mgr.startAccountAuth("anthropic", account.id);
        expect(claude.getActiveAccountId()).toBe(account.id);

        mgr.delete("anthropic", account.id);

        expect(claude.cancelCalls).toBe(1);
        expect(claude.getActiveAccountId()).toBeNull();
        // And a fresh account can sign in rather than hitting a phantom owner.
        const replacement = mgr.create("anthropic", "Replacement");
        expect(() => mgr.startAccountAuth("anthropic", replacement.id)).not.toThrow();
      });

      it("deleting an unrelated row leaves the in-flight sign-in alone", () => {
        const { mgr, claude, account } = setup();
        const second = mgr.create("anthropic", "Work");
        mgr.startAccountAuth("anthropic", account.id);

        mgr.delete("anthropic", second.id);

        expect(claude.cancelCalls).toBe(0);
        expect(claude.getActiveAccountId()).toBe(account.id);
      });

      // A row stuck on `authenticating` blocks every other account, so a
      // sign-in that never started must not leave one behind.
      it("puts the row back when the login process fails to start", () => {
        const { mgr, claude, account } = setup();
        claude.startShouldThrow = new Error("spawn ENOENT");

        expect(() => mgr.startAccountAuth("anthropic", account.id)).toThrow(/spawn ENOENT/);

        expect(mgr.get("anthropic", account.id)?.status).toBe("unavailable");
        // ...and the provider is still usable by anyone else.
        const second = mgr.create("anthropic", "Work");
        claude.startShouldThrow = null;
        expect(() => mgr.startAccountAuth("anthropic", second.id)).not.toThrow();
      });

      it("refuses a pasted code when no sign-in is running at all", () => {
        const { mgr, claude, account } = setup();
        // Timed out, cancelled, or lost to a restart. Previously the manager
        // logged and dropped it while the endpoint answered 200.
        expect(() => mgr.submitAccountCode("anthropic", account.id, "abc-123")).toThrow(/no longer running/i);
        expect(claude.codeCalls).toEqual([]);
      });

      it("refuses a code pasted on a row that does not own the flow", () => {
        const { mgr, claude, account } = setup();
        const second = mgr.create("anthropic", "Work");
        mgr.startAccountAuth("anthropic", account.id);

        // The code belongs to the challenge that issued it; submitting it here
        // would authenticate the wrong account.
        expect(() => mgr.submitAccountCode("anthropic", second.id, "abc-123")).toThrow(/already signing in/i);
        expect(claude.codeCalls).toEqual([]);
      });
    });

    it("submitAccountCode throws when the provider flow has no code step", () => {
      const { mgr, codex, account } = setup();
      const codexAccount = mgr.create("openai", "Personal");
      (codex as { submitCode?: unknown }).submitCode = undefined;
      expect(() => mgr.submitAccountCode("openai", codexAccount.id, "x")).toThrow(/no code-submission step/i);
      expect(account).toBeDefined();
    });

    it("signOutAccount removes the account credentials and marks the row unavailable", () => {
      const { mgr, claude, account } = setup();
      mgr.setAccountStatus("anthropic", account.id, "ready");
      const result = mgr.signOutAccount("anthropic", account.id);
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
      const second = mgr.create("anthropic", "Work");
      for (const id of [account.id, second.id]) {
        const dir = path.join(mgr.resolveCredentialRoot("claude", id), ".claude");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, ".credentials.json"), "{}");
      }

      mgr.signOutProvider("claude");

      expect(mgr.list("anthropic")).toEqual([]);
      for (const id of [account.id, second.id]) {
        expect(fs.existsSync(mgr.resolveCredentialRoot("claude", id))).toBe(false);
      }
      // The unscoped sign-out still runs, for installs that never migrated.
      expect(claude.signOutCalls).toContainEqual({});
    });

    it("signOutProvider ends an in-flight login on an account it is deleting", () => {
      const { mgr, claude, account } = setup();
      mgr.startAccountAuth("anthropic", account.id);
      expect(claude.getActiveAccountId()).toBe(account.id);

      mgr.signOutProvider("claude");

      expect(claude.getActiveAccountId()).toBeNull();
    });

    it("scoped-auth methods throw a clear error when no auth managers are wired", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const account = mgr.create("anthropic");
      expect(() => mgr.startAccountAuth("anthropic", account.id)).toThrow(/no auth manager wired/i);
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
      const a = mgr.create("anthropic", "A");
      const b = mgr.create("anthropic", "B");
      mgr.setAccountStatus("anthropic", a.id, "ready");
      mgr.setAccountStatus("anthropic", b.id, "ready");
      // No quota snapshot at all — the stamp is the only signal there is.
      expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: a.id } });

      const until = Date.now() + 3_600_000;
      mgr.markAccountExhausted("anthropic", a.id, until);

      expect(refusalBlockedUntil(mgr.get("anthropic", a.id)!, Date.now())).not.toBeNull();
      expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: b.id } });
    });

    it("persists across manager instances (a restart must not un-bench it)", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      mgr.setAccountStatus("anthropic", a.id, "ready");
      const until = Date.now() + 3_600_000;
      mgr.markAccountExhausted("anthropic", a.id, until);

      const reloaded = new ProviderAccountManager({
        credentialsDir: root,
        credentialStore: new CredentialStore(root),
      });
      expect(refusalBlockedUntil(reloaded.get("anthropic", a.id)!, Date.now())).not.toBeNull();
    });

    it("expires on its own, so a lockout can never outlive its reset", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      mgr.setAccountStatus("anthropic", a.id, "ready");
      mgr.markAccountExhausted("anthropic", a.id, Date.now() - 1_000);

      expect(refusalBlockedUntil(mgr.get("anthropic", a.id)!, Date.now())).toBeNull();
    });

    // docs/260 req 9 — the newest refusal's stated reset supersedes an older,
    // longer estimate. A re-probe answered with "resets in a minute" must not
    // leave the account benched on a stale two-hour deadline.
    it("the newest refusal's stated reset wins, even when it is earlier", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      mgr.setAccountStatus("anthropic", a.id, "ready");
      const far = Date.now() + 7_200_000;
      const near = Date.now() + 60_000;
      mgr.markAccountExhausted("anthropic", a.id, far);
      mgr.markAccountExhausted("anthropic", a.id, near);

      expect(mgr.get("anthropic", a.id)?.exhaustedUntil).toBe(near);
    });

    it("ignores an unknown account rather than inventing a row", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      expect(mgr.markAccountExhausted("anthropic", "acct_nope", Date.now() + 1000)).toBeNull();
      expect(mgr.list("anthropic")).toEqual([]);
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
        const account = mgr.create("anthropic", label);
        mgr.setAccountStatus("anthropic", account.id, "ready");
        return account.id;
      });
      return { mgr, ids };
    }

    it("selects in the user's order, not creation order", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("anthropic", [ids[2]!, ids[0]!, ids[1]!]);

      expect(mgr.accountsInSelectionOrder("anthropic").map((a) => a.id)).toEqual([ids[2], ids[0], ids[1]]);
      expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: ids[2] } });
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
      mgr.reorder("anthropic", [ids[2]!, ids[0]!, ids[1]!]);

      expect(mgr.list("anthropic").map((a) => a.id)).toEqual([ids[2], ids[0], ids[1]]);
      // And through the all-providers form the SSE broadcast uses.
      expect(mgr.list().filter((a) => a.serviceId === "anthropic").map((a) => a.id))
        .toEqual([ids[2], ids[0], ids[1]]);
    });

    it("survives a restart", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("anthropic", [ids[1]!, ids[2]!, ids[0]!]);

      const reloaded = new ProviderAccountManager({
        credentialsDir: root,
        credentialStore: new CredentialStore(root),
      });
      expect(reloaded.accountsInSelectionOrder("anthropic").map((a) => a.id)).toEqual([ids[1], ids[2], ids[0]]);
    });

    // Otherwise connecting an account would silently change which subscription
    // existing work runs on.
    it("appends a newly connected account rather than inserting it", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("anthropic", [ids[2]!, ids[0]!, ids[1]!]);
      const fresh = mgr.create("anthropic", "D");
      mgr.setAccountStatus("anthropic", fresh.id, "ready");

      expect(mgr.accountsInSelectionOrder("anthropic").map((a) => a.id)).toEqual([ids[2], ids[0], ids[1], fresh.id]);
      expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: ids[2] } });
    });

    it("keeps isPrimary in step with position 0 so the two cannot disagree", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("anthropic", [ids[1]!, ids[0]!, ids[2]!]);

      expect(mgr.get("anthropic", ids[1]!)?.isPrimary).toBe(true);
      expect(mgr.get("anthropic", ids[0]!)?.isPrimary).toBe(false);
      expect(mgr.getPrimary("anthropic")?.id).toBe(ids[1]);
    });

    it("promotes to the front via makePrimary without disturbing the rest", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("anthropic", [ids[0]!, ids[1]!, ids[2]!]);
      mgr.makePrimary("anthropic", ids[2]!);

      expect(mgr.accountsInSelectionOrder("anthropic").map((a) => a.id)).toEqual([ids[2], ids[0], ids[1]]);
    });

    // A stale client — one whose list predates an account added in another tab
    // — must fail loudly rather than quietly demoting the account it never saw.
    it("rejects a partial, duplicated, or foreign order", () => {
      const { mgr, ids } = threeReady();
      expect(() => mgr.reorder("anthropic", [ids[0]!, ids[1]!])).toThrow(/exactly once/);
      expect(() => mgr.reorder("anthropic", [ids[0]!, ids[0]!, ids[1]!])).toThrow(/duplicates/);
      expect(() => mgr.reorder("anthropic", [ids[0]!, ids[1]!, "acct_nope"])).toThrow(/exactly once/);
      // Nothing was written on any of the rejected calls.
      expect(mgr.accountsInSelectionOrder("anthropic").map((a) => a.id)).toEqual(ids);
    });

    // Rows written before `priority` existed must keep behaving exactly as they
    // did, or an upgrade would silently move which account turns run on. That
    // used to be a read-time fallback; docs/150 req 19 replaces it with a
    // one-time backfill, so the guarantee is asserted against the backfill.
    const stripPriority = (mgr: ProviderAccountManager, ids: string[], primaryId: string): void => {
      for (const id of ids) {
        const account = mgr.get("anthropic", id)!;
        const { priority: _dropped, ...legacy } = account;
        store.upsertCredentialRoute({ ...legacy, isPrimary: id === primaryId });
      }
    };

    it("backfills priority from the order legacy rows already resolved to", () => {
      const { mgr, ids } = threeReady();
      stripPriority(mgr, ids as string[], ids[1]!);

      mgr.backfillPriority();

      // Same order the old primary-then-stored-order rule produced.
      expect(mgr.list("anthropic").map((a) => a.id)).toEqual([ids[1], ids[0], ids[2]]);
      expect(mgr.list("anthropic").map((a) => a.priority)).toEqual([0, 1, 2]);
      // And it is now recorded, so the legacy rule is never needed again.
      expect(
        store.listCredentialRoutes("anthropic", "sub").every((a) => typeof a.priority === "number"),
      ).toBe(true);
    });

    it("backfill is idempotent and does not disturb an explicit order", () => {
      const { mgr, ids } = threeReady();
      mgr.reorder("anthropic", [ids[2]!, ids[0]!, ids[1]!]);

      mgr.backfillPriority();
      mgr.backfillPriority();

      expect(mgr.list("anthropic").map((a) => a.id)).toEqual([ids[2], ids[0], ids[1]]);
    });

    // req 19 — one fact, one field. `isPrimary` is position 0, always.
    it("derives isPrimary from position rather than the stored flag", () => {
      const { mgr, ids } = threeReady();
      // Poison the stored flag: claim the LAST row is primary.
      const last = mgr.get("anthropic", ids[2]!)!;
      store.upsertCredentialRoute({ ...last, isPrimary: true });

      const rows = mgr.list("anthropic");
      expect(rows.map((a) => a.isPrimary)).toEqual([true, false, false]);
      expect(rows[0]!.id).toBe(ids[0]);
      // Every accessor agrees — a caller must not get a different answer
      // depending on which one it reached for.
      expect(mgr.get("anthropic", ids[0]!)?.isPrimary).toBe(true);
      expect(mgr.get("anthropic", ids[2]!)?.isPrimary).toBe(false);
      expect(mgr.getPrimary("anthropic")?.id).toBe(ids[0]);
    });

    it("moves the primary badge with the order", () => {
      const { mgr, ids } = threeReady();
      expect(mgr.getPrimary("anthropic")?.id).toBe(ids[0]);

      mgr.makePrimary("anthropic", ids[2]!);

      expect(mgr.getPrimary("anthropic")?.id).toBe(ids[2]);
      expect(mgr.list("anthropic").map((a) => a.isPrimary)).toEqual([true, false, false]);
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
        getSubscriptionLimits: () => ({ "anthropic:sub": limits as never }),
      });
    }

    function twoReadyAccounts(): { a: string; b: string } {
      const seed = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = seed.create("anthropic", "A");
      const b = seed.create("anthropic", "B");
      seed.setAccountStatus("anthropic", a.id, "ready");
      seed.setAccountStatus("anthropic", b.id, "ready");
      return { a: a.id, b: b.id };
    }

    it("defaults both cutoffs to 90% (req 5)", () => {
      expect(store.getFailoverCutoffs("anthropic", "sub")).toEqual({ session: 90, weekly: 90 });
    });

    it("moves new work off an account past the short-window cutoff (req 6)", () => {
      const { a, b } = twoReadyAccounts();
      const mgr = mgrWith({ [a]: { session: win(92) }, [b]: { session: win(10) } });

      expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: b } });
    });

    it("moves new work off an account past the weekly cutoff too (req 4)", () => {
      const { a, b } = twoReadyAccounts();
      const mgr = mgrWith({ [a]: { session: win(10), weekly: win(95) }, [b]: { session: win(10) } });

      expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: b } });
    });

    // The whole point of the three-tier split. At 92% an account still has 8%
    // of its window left; failing the turn would waste it.
    it("still uses an over-cutoff account when every account is over its cutoff", () => {
      const { a, b } = twoReadyAccounts();
      const mgr = mgrWith({ [a]: { session: win(92) }, [b]: { session: win(97) } });

      expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: a } });
    });

    // docs/260 reqs 5, 9 — telemetry claiming 100% ORDERS an account to the
    // back but cannot block it: the account is still tried, once, to confirm.
    // Only a refusal the harness itself reported may skip an account.
    it("still tries a telemetry-spent account rather than refusing untried (reqs 5, 9)", () => {
      const { a, b } = twoReadyAccounts();
      const mgr = mgrWith({ [a]: { session: win(100) }, [b]: { session: win(100) } });

      expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: a } });
    });

    it("honours a configured cutoff instead of the default", () => {
      const { a, b } = twoReadyAccounts();
      store.setFailoverCutoffs("anthropic", "sub", { session: 50 });
      const mgr = mgrWith({ [a]: { session: win(60) }, [b]: { session: win(10) } });

      expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: b } });
    });

    // Claude reports usedPct only above a warning threshold, so silence must
    // not read as "past 90%" — that would demote every healthy account.
    it("treats an unreported percentage as under the cutoff", () => {
      const { a } = twoReadyAccounts();
      const mgr = mgrWith({ [a]: { session: win(null) } });

      expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: a } });
    });

    /**
     * docs/260 req 8 — the move BACK. Snapshots are event-fed only, so an
     * account nothing routes to never reports again; if its last reading kept
     * demoting it, the demotion became permanent and strict priority could
     * never return to the primary. An expired window is not evidence.
     */
    describe("an expired window stops counting (docs/260 req 8)", () => {
      const expired = (usedPct: number | null) => ({
        usedPct,
        resetAt: new Date(Date.now() - 60_000).toISOString(),
      });

      it("routes back to the primary once its short window has reset", () => {
        const { a, b } = twoReadyAccounts();
        // A hit its 5h limit and everything moved to B. The window has since
        // reset; A's snapshot still reads 100 because no turn ran on it.
        const mgr = mgrWith({ [a]: { session: expired(100) }, [b]: { session: win(10) } });

        expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: a } });
      });

      it("keeps the demotion while the over-cutoff window is still open", () => {
        const { a, b } = twoReadyAccounts();
        const mgr = mgrWith({ [a]: { session: win(92) }, [b]: { session: win(10) } });

        expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: b } });
      });

      // The 5h window resets many times inside one weekly window, so an
      // expired session window must not excuse a live weekly one.
      it("still demotes on a live weekly window when the short one has reset", () => {
        const { a, b } = twoReadyAccounts();
        const mgr = mgrWith({
          [a]: { session: expired(100), weekly: win(95) },
          [b]: { session: win(10) },
        });

        expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: b } });
      });

      // Conservative, and cheap: a demotion only orders an account last, and
      // every tier is still tried (req 5).
      it("treats an unparseable reset time as not expired", () => {
        const { a, b } = twoReadyAccounts();
        const mgr = mgrWith({
          [a]: { session: { usedPct: 95, resetAt: "not-a-date" } },
          [b]: { session: win(10) },
        });

        expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: b } });
      });
    });

    // docs/260 — the pinned-route probes (`isRouteUsableForTurn`,
    // `classifyRouteForTurn`) are gone with pinning itself: selection answers
    // every routing question, and cutoffs are ordering, never displacement.
    describe("per-turn ordering (docs/260 reqs 5, 8)", () => {
      it("orders an over-cutoff account behind a clear one, and a telemetry-spent one last", () => {
        const { a, b } = twoReadyAccounts();
        const mgr = mgrWith({ [a]: { session: win(92) }, [b]: { session: win(100) } });

        // a is over its cutoff (has quota left), b LOOKS spent — a wins, and b
        // would still be tried if a were excluded (req 5: never block untried).
        expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: true, route: { kind: "account", id: a } });
        expect(mgr.selectAccountForTurn("anthropic", { exclude: [a] })).toEqual({
          ok: true,
          route: { kind: "account", id: b },
        });
      });

      it("under balanced, an eligible resident account keeps serving its session (req 8)", () => {
        const { a, b } = twoReadyAccounts();
        store.setSelectionMode("anthropic", "sub", "balanced");
        const mgr = mgrWith({ [a]: { session: win(10) }, [b]: { session: win(10) } });
        // Make b the least-recently-used, which plain balanced would pick.
        mgr.markAccountUsed("anthropic", a);

        expect(mgr.selectAccountForTurn("anthropic", { residentRouteId: a })).toEqual({
          ok: true,
          route: { kind: "account", id: a },
        });
        store.setSelectionMode("anthropic", "sub", "strict");
      });

      it("under strict, the strategy is absolute and the resident option is ignored (req 8)", () => {
        const { a, b } = twoReadyAccounts();
        const mgr = mgrWith({ [a]: { session: win(10) }, [b]: { session: win(10) } });

        expect(mgr.selectAccountForTurn("anthropic", { residentRouteId: b })).toEqual({
          ok: true,
          route: { kind: "account", id: a },
        });
      });

      it("a resident account that is over its cutoff stops being preferred (req 8)", () => {
        const { a, b } = twoReadyAccounts();
        store.setSelectionMode("anthropic", "sub", "balanced");
        const mgr = mgrWith({ [a]: { session: win(95) }, [b]: { session: win(10) } });

        expect(mgr.selectAccountForTurn("anthropic", { residentRouteId: a })).toEqual({
          ok: true,
          route: { kind: "account", id: b },
        });
        store.setSelectionMode("anthropic", "sub", "strict");
      });
    });
  });

  describe("selectAccountForTurn (docs/150 reqs 13, 14, 17)", () => {
    const READY = "ready" as const;

    function withLimits(
      root: string,
      store: CredentialStore,
      limits: Record<string, {
        session?: { usedPct: number | null; resetAt: string } | null;
        weekly?: { usedPct: number | null; resetAt: string } | null;
        fetchedAt?: number;
      }>,
    ): ProviderAccountManager {
      return new ProviderAccountManager({
        credentialsDir: root,
        credentialStore: store,
        getSubscriptionLimits: () => ({ "anthropic:sub": limits as never }),
      });
    }

    it("skips an exhausted account and picks the next one with quota", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      const b = mgr.create("anthropic", "B");
      mgr.setAccountStatus("anthropic", a.id, READY);
      mgr.setAccountStatus("anthropic", b.id, READY);

      const quota = withLimits(root, store, {
        [a.id]: { session: { usedPct: 100, resetAt: new Date(Date.now() + 3_600_000).toISOString() } },
        [b.id]: { session: { usedPct: 20, resetAt: new Date(Date.now() + 3_600_000).toISOString() } },
      });

      expect(quota.selectAccountForTurn("anthropic")).toEqual({
        ok: true,
        route: { kind: "account", id: b.id },
      });
    });

    // docs/260 req 9 — telemetry alone cannot produce all_exhausted: an
    // account whose DATA says spent is tried once to confirm. Only remembered
    // refusals (below) can make selection fail — and even those yield to an
    // optimistic caller (req 12).
    it("tries the first telemetry-spent account instead of failing untried (reqs 5, 9)", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      const b = mgr.create("anthropic", "B");
      mgr.setAccountStatus("anthropic", a.id, READY);
      mgr.setAccountStatus("anthropic", b.id, READY);

      const later = new Date(Date.now() + 7_200_000).toISOString();
      const sooner = new Date(Date.now() + 1_800_000).toISOString();
      const quota = withLimits(root, store, {
        [a.id]: { session: { usedPct: 100, resetAt: later } },
        [b.id]: { session: { usedPct: 100, resetAt: sooner } },
      });

      expect(quota.selectAccountForTurn("anthropic")).toEqual({
        ok: true,
        route: { kind: "account", id: a.id },
      });
    });

    it("reports all_exhausted only from remembered refusals, with the soonest re-try (req 9)", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      const b = mgr.create("anthropic", "B");
      mgr.setAccountStatus("anthropic", a.id, READY);
      mgr.setAccountStatus("anthropic", b.id, READY);
      mgr.markAccountExhausted("anthropic", a.id, Date.now() + 7_200_000);
      mgr.markAccountExhausted("anthropic", b.id, Date.now() + 7_200_000);

      const selection = mgr.selectAccountForTurn("anthropic");
      expect(selection).toMatchObject({ ok: false, reason: "all_exhausted" });
      // req 12 — a caller that will ATTEMPT the result gets the best blocked
      // account instead of the failure, so a resend re-tries every account.
      expect(mgr.selectAccountForTurn("anthropic", { optimistic: true })).toEqual({
        ok: true,
        route: { kind: "account", id: a.id },
      });
    });

    it("never fails over onto metered API billing (req 12)", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      mgr.setAccountStatus("anthropic", a.id, READY);
      const quota = withLimits(root, store, {
        [a.id]: { session: { usedPct: 100, resetAt: new Date(Date.now() + 3_600_000).toISOString() } },
      });

      // The reserved API-key route exists, but a spent-looking *subscription*
      // must be tried (req 5) — and never silently replaced by pay-as-you-go
      // money (req 7). Bench it with a real refusal and the answer is a
      // failure, still not the metered key.
      expect(quota.selectAccountForTurn("anthropic")).toEqual({
        ok: true,
        route: { kind: "account", id: a.id },
      });
      quota.markAccountExhausted("anthropic", a.id, Date.now() + 3_600_000);
      expect(quota.selectAccountForTurn("anthropic").ok).toBe(false);
    });

    it("treats unknown quota as usable rather than locking out a fresh account", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      mgr.setAccountStatus("anthropic", a.id, READY);
      // Claude reports no usedPct below its warning threshold; Codex reports
      // nothing until a turn has run.
      const quota = withLimits(root, store, { [a.id]: { session: { usedPct: null, resetAt: "x" } } });

      expect(quota.selectAccountForTurn("anthropic")).toEqual({
        ok: true,
        route: { kind: "account", id: a.id },
      });
    });

    it("ignores an exhausted window whose reset has already passed", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      mgr.setAccountStatus("anthropic", a.id, READY);
      const quota = withLimits(root, store, {
        [a.id]: { session: { usedPct: 100, resetAt: new Date(Date.now() - 60_000).toISOString() } },
      });

      expect(quota.selectAccountForTurn("anthropic").ok).toBe(true);
    });

    it("excludes a route that already failed this turn (req 14)", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      const b = mgr.create("anthropic", "B");
      mgr.setAccountStatus("anthropic", a.id, READY);
      mgr.setAccountStatus("anthropic", b.id, READY);

      expect(mgr.selectAccountForTurn("anthropic", { exclude: [a.id] })).toEqual({
        ok: true,
        route: { kind: "account", id: b.id },
      });
    });



    it("reports auth_required when nothing is connected", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      expect(mgr.selectAccountForTurn("anthropic")).toEqual({ ok: false, reason: "auth_required" });
    });

    it("keeps a remembered refusal out of the running until it lapses (req 9)", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      const b = mgr.create("anthropic", "B");
      mgr.setAccountStatus("anthropic", a.id, READY);
      mgr.setAccountStatus("anthropic", b.id, READY);
      // Hard refusal reported mid-turn, before any new snapshot arrives.
      mgr.markAccountExhausted("anthropic", a.id, Date.now() + 3_600_000);

      expect(mgr.selectAccountForTurn("anthropic")).toEqual({
        ok: true,
        route: { kind: "account", id: b.id },
      });
    });

    it("treats a LEGACY bench with no observation clock as expired — the deploy migration (req 9)", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      mgr.setAccountStatus("anthropic", a.id, READY);
      // A pre-260 bench: exhaustedUntil far in the future, no exhaustedAt.
      // These are exactly the rows the 2026-08-10 incident showed can go
      // permanently stale; the read rule bounds them to nothing at all.
      store.upsertCredentialRoute({
        ...mgr.get("anthropic", a.id)!,
        exhaustedUntil: Date.now() + 7 * 24 * 3_600_000,
        exhaustedAt: null,
      });

      expect(mgr.selectAccountForTurn("anthropic")).toEqual({
        ok: true,
        route: { kind: "account", id: a.id },
      });
    });

    it("re-probes a refusal after the cap even when the stated reset is far away (req 9)", () => {
      const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
      const a = mgr.create("anthropic", "A");
      mgr.setAccountStatus("anthropic", a.id, READY);
      const weekly = Date.now() + 7 * 24 * 3_600_000;
      // A refusal observed 31 minutes ago with a week-long stated reset: the
      // cap (REFUSAL_REPROBE_MS) makes it eligible again — one probe attempt,
      // not a week of silence.
      store.upsertCredentialRoute({
        ...mgr.get("anthropic", a.id)!,
        exhaustedUntil: weekly,
        exhaustedAt: Date.now() - REFUSAL_REPROBE_MS - 60_000,
      });

      expect(mgr.selectAccountForTurn("anthropic")).toEqual({
        ok: true,
        route: { kind: "account", id: a.id },
      });
    });

    // docs/260 req 9 — refusal memory clears on a HEALTHY reading newer than
    // the refusal (lazily, at the selection read), and never on anything less.
    describe("refusal memory clearing (req 9)", () => {
      function setupBenchedPair() {
        const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
        const healthy = mgr.create("anthropic", "Healthy");
        const spent = mgr.create("anthropic", "Spent");
        mgr.setAccountStatus("anthropic", healthy.id, READY);
        mgr.setAccountStatus("anthropic", spent.id, READY);
        const exhaustedAt = Date.now() - 1_000;
        for (const account of [healthy, spent]) {
          store.upsertCredentialRoute({
            ...mgr.get("anthropic", account.id)!,
            exhaustedUntil: Date.now() + 3_600_000,
            exhaustedAt,
          });
        }
        return { healthy, spent, exhaustedAt };
      }

      const windows = (fetchedAt: number, weeklyPct: number | null = 19) => ({
        session: { usedPct: 2, resetAt: new Date(Date.now() + 3_600_000).toISOString() },
        weekly: { usedPct: weeklyPct, resetAt: new Date(Date.now() + 7_200_000).toISOString() },
        fetchedAt,
      });

      it("a newer healthy snapshot clears the refusal during selection", () => {
        const { healthy, spent, exhaustedAt } = setupBenchedPair();
        const quota = withLimits(root, store, {
          [healthy.id]: windows(exhaustedAt + 1),
          [spent.id]: {
            ...windows(exhaustedAt + 1),
            session: { usedPct: 100, resetAt: new Date(Date.now() + 3_600_000).toISOString() },
          },
        });

        expect(quota.selectAccountForTurn("anthropic")).toEqual({
          ok: true,
          route: { kind: "account", id: healthy.id },
        });
        expect(store.getCredentialRoute(healthy.id)?.exhaustedUntil).toBeNull();
        // A still-100% reading clears nothing; that account stays blocked.
        expect(store.getCredentialRoute(spent.id)?.exhaustedUntil).not.toBeNull();
      });

      it("a null usedPct counts as HEALTHY — below the warning threshold, not unknown-bad", () => {
        // The old machinery demanded numeric proof and could never clear a
        // bench for a lightly-used account (the provider reports numbers only
        // above a warning threshold). A wrong clear now costs one refused
        // attempt (req 5), so silence is read as health.
        const { healthy, exhaustedAt } = setupBenchedPair();
        const quota = withLimits(root, store, { [healthy.id]: windows(exhaustedAt + 1, null) });

        expect(quota.selectAccountForTurn("anthropic")).toEqual({
          ok: true,
          route: { kind: "account", id: healthy.id },
        });
        expect(store.getCredentialRoute(healthy.id)?.exhaustedUntil).toBeNull();
      });

      it("keeps the memory when quota is absent — but the cap still bounds it", () => {
        const { healthy, spent } = setupBenchedPair();
        const quota = withLimits(root, store, {});
        // No snapshot to clear with: both stay blocked and selection fails
        // (non-optimistic); the ~30-minute cap is what bounds this state.
        expect(quota.selectAccountForTurn("anthropic")).toMatchObject({ ok: false, reason: "all_exhausted" });
        expect(store.getCredentialRoute(healthy.id)?.exhaustedUntil).not.toBeNull();
        expect(store.getCredentialRoute(spent.id)?.exhaustedUntil).not.toBeNull();
      });

      it("keeps the memory when either window remains exhausted", () => {
        const { healthy, exhaustedAt } = setupBenchedPair();
        const quota = withLimits(root, store, { [healthy.id]: windows(exhaustedAt + 1, 100) });
        quota.selectAccountForTurn("anthropic");
        expect(store.getCredentialRoute(healthy.id)?.exhaustedUntil).not.toBeNull();
      });

      it("rejects an older snapshot but accepts a later one after a restart", () => {
        const { healthy, exhaustedAt } = setupBenchedPair();
        const stale = withLimits(root, store, { [healthy.id]: windows(exhaustedAt - 1) });
        stale.selectAccountForTurn("anthropic");
        expect(store.getCredentialRoute(healthy.id)?.exhaustedUntil).not.toBeNull();

        const restartedStore = new CredentialStore(root);
        const fresh = withLimits(root, restartedStore, { [healthy.id]: windows(exhaustedAt + 1) });
        expect(fresh.selectAccountForTurn("anthropic")).toEqual({
          ok: true,
          route: { kind: "account", id: healthy.id },
        });
        expect(restartedStore.getCredentialRoute(healthy.id)?.exhaustedUntil).toBeNull();
      });

      it("does not let a pre-failure snapshot weaken same-turn failover", () => {
        const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
        const account = mgr.create("anthropic", "Account");
        mgr.setAccountStatus("anthropic", account.id, READY);
        const snapshotAt = Date.now() - 1_000;
        const quota = withLimits(root, store, { [account.id]: windows(snapshotAt) });
        quota.markAccountExhausted("anthropic", account.id, Date.now() + 3_600_000);

        expect(quota.selectAccountForTurn("anthropic")).toMatchObject({ ok: false, reason: "all_exhausted" });
      });

      it("refreshes the observation clock and adopts the newest stated reset on a repeated refusal", () => {
        const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
        const account = mgr.create("anthropic", "Account");
        mgr.setAccountStatus("anthropic", account.id, READY);
        const far = Date.now() + 7_200_000;
        mgr.markAccountExhausted("anthropic", account.id, far);
        const first = store.getCredentialRoute(account.id)!;
        const snapshotAt = first.exhaustedAt! + 1;
        while (Date.now() <= snapshotAt) { /* establish strict event order */ }
        const quota = withLimits(root, store, { [account.id]: windows(snapshotAt) });
        const near = Date.now() + 60_000;
        quota.markAccountExhausted("anthropic", account.id, near);

        expect(quota.selectAccountForTurn("anthropic")).toMatchObject({ ok: false, reason: "all_exhausted" });
        // docs/260 req 9 — the newest refusal's stated reset replaces the
        // older, longer estimate; the refreshed `exhaustedAt` clock is what
        // keeps the memory alive past any pre-failure snapshot.
        expect(store.getCredentialRoute(account.id)?.exhaustedUntil).toBe(near);
      });
    });
  });
});
