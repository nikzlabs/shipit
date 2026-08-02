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
    // did, or an upgrade would silently move which account turns run on.
    it("falls back to primary-then-stored-order for rows with no stored priority", () => {
      const { mgr, ids } = threeReady();
      for (const id of ids) {
        const account = mgr.get("claude", id)!;
        const { priority: _dropped, ...legacy } = account;
        store.upsertProviderAccount({ ...legacy, isPrimary: id === ids[1] });
      }

      expect(mgr.accountsInSelectionOrder("claude").map((a) => a.id)).toEqual([ids[1], ids[0], ids[2]]);
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
