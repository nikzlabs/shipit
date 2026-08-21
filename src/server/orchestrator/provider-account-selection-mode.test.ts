/**
 * docs/150-multiple-provider-subscriptions req 21 — the per-provider account selection mode.
 *
 * `strict` is today's behavior: the user's order is a preference, and work
 * starts on the highest-ranked eligible account. `balanced` treats the accounts
 * as peers and starts new work on whichever has been used least, so their quota
 * drains at a comparable rate.
 *
 * The mode decides where work *starts*. It must never decide *whether* failover
 * happens — req 15 keeps that on unconditionally — so several tests here assert
 * that the two modes behave identically once eligibility is in play.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credential-store.js";
import { ProviderAccountManager, orderForSelectionMode } from "./provider-account-manager.js";
import type { CredentialRoute, SubscriptionLimitsMap } from "../shared/types.js";

function account(id: string, lastUsedAt?: number): CredentialRoute {
  return {
    id,
    serviceId: "anthropic", billingMode: "sub", via: "account",
    label: id,
    isPrimary: false,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
  };
}

describe("orderForSelectionMode", () => {
  it("leaves the user's priority order alone under strict", () => {
    const accounts = [account("a", 900), account("b", 100)];
    expect(orderForSelectionMode(accounts, "strict").map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("puts the least-recently-used account first under balanced", () => {
    const accounts = [account("a", 900), account("b", 100)];
    expect(orderForSelectionMode(accounts, "balanced").map((a) => a.id)).toEqual(["b", "a"]);
  });

  it("treats a never-used account as the least recently used", () => {
    // A freshly connected account has no stamp at all. It should be tried
    // before one that has been carrying work, not sorted arbitrarily.
    const accounts = [account("used", 500), account("fresh")];
    expect(orderForSelectionMode(accounts, "balanced").map((a) => a.id)).toEqual(["fresh", "used"]);
  });

  it("falls back to the user's order when everything ties", () => {
    // The state of a fresh install: nothing has run, so every stamp is absent.
    // A stable sort means `balanced` degrades to `strict` here rather than to
    // something arbitrary — which is what makes the mode safe to default on a
    // system with no history.
    const accounts = [account("first"), account("second"), account("third")];
    expect(orderForSelectionMode(accounts, "balanced").map((a) => a.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("does not mutate the array it was given", () => {
    const accounts = [account("a", 900), account("b", 100)];
    orderForSelectionMode(accounts, "balanced");
    expect(accounts.map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("selectAccountForTurn — selection mode (req 21)", () => {
  let root: string;
  let store: CredentialStore;
  let savedSessionId: string | undefined;

  function manager(limits?: SubscriptionLimitsMap): ProviderAccountManager {
    return new ProviderAccountManager({
      credentialsDir: root,
      credentialStore: store,
      ...(limits ? { getSubscriptionLimits: () => limits } : {}),
    });
  }

  /** Two ready accounts in a known priority order, neither ever used. */
  function twoAccounts(mgr: ProviderAccountManager): [string, string] {
    const a = mgr.create("anthropic", "First");
    const b = mgr.create("anthropic", "Second");
    mgr.setAccountStatus("anthropic", a.id, "ready");
    mgr.setAccountStatus("anthropic", b.id, "ready");
    return [a.id, b.id];
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-selection-mode-"));
    store = new CredentialStore(root);
    savedSessionId = process.env.SHIPIT_SESSION_ID;
    delete process.env.SHIPIT_SESSION_ID;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    if (savedSessionId === undefined) delete process.env.SHIPIT_SESSION_ID;
    else process.env.SHIPIT_SESSION_ID = savedSessionId;
  });

  it("defaults to strict, so an untouched install is unchanged", () => {
    expect(store.getSelectionMode("anthropic", "sub")).toBe("strict");
  });

  it("strict keeps every consecutive selection on the highest-ranked account", () => {
    const mgr = manager();
    const [first] = twoAccounts(mgr);

    // Simulate three sessions pinning in a row, stamping usage each time the
    // way `prepareSessionAgentEnvironment` does.
    const picks: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sel = mgr.selectAccountForTurn("anthropic");
      if (!sel.ok) throw new Error("expected a route");
      picks.push(sel.route.id);
      mgr.markAccountUsed("anthropic", sel.route.id);
    }

    expect(picks).toEqual([first, first, first]);
  });

  it("balanced spreads consecutive selections across the eligible accounts", () => {
    store.setSelectionMode("anthropic", "sub", "balanced");
    const mgr = manager();
    const [first, second] = twoAccounts(mgr);

    const picks: string[] = [];
    for (let i = 0; i < 4; i++) {
      const sel = mgr.selectAccountForTurn("anthropic");
      if (!sel.ok) throw new Error("expected a route");
      picks.push(sel.route.id);
      mgr.markAccountUsed("anthropic", sel.route.id);
    }

    // Alternating is the observable consequence; the point is that no account
    // is used twice before the other has been used once.
    expect(picks).toEqual([first, second, first, second]);
  });

  it("balanced still refuses an exhausted account rather than balancing onto it", () => {
    store.setSelectionMode("anthropic", "sub", "balanced");
    const resetAt = Date.now() + 60 * 60 * 1000;
    const mgr = manager();
    const [first, second] = twoAccounts(mgr);
    // Make the LRU account the exhausted one, so a mode that ignored
    // eligibility would pick exactly the wrong row.
    mgr.markAccountUsed("anthropic", second);
    mgr.markAccountExhausted("anthropic", first, resetAt);

    const sel = mgr.selectAccountForTurn("anthropic");

    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel.route.id).toBe(second);
  });

  it("fails over identically in both modes, and honours the retry exclusion (req 15)", () => {
    // req 15 — the mode chooses where work starts, never whether failover
    // happens. With the first account excluded (the shape of a same-turn retry
    // after hard exhaustion), both modes must land on the second.
    for (const mode of ["strict", "balanced"] as const) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      store = new CredentialStore(root);
      store.setSelectionMode("anthropic", "sub", mode);
      const mgr = manager();
      const [first, second] = twoAccounts(mgr);

      const sel = mgr.selectAccountForTurn("anthropic", { exclude: [first] });

      expect(sel.ok).toBe(true);
      if (sel.ok) expect(sel.route.id, `mode=${mode}`).toBe(second);
    }
  });

  it("reports all_exhausted in both modes when nothing can run", () => {
    const resetAt = Date.now() + 30 * 60 * 1000;
    for (const mode of ["strict", "balanced"] as const) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      store = new CredentialStore(root);
      store.setSelectionMode("anthropic", "sub", mode);
      const mgr = manager();
      const [first, second] = twoAccounts(mgr);
      mgr.markAccountExhausted("anthropic", first, resetAt);
      mgr.markAccountExhausted("anthropic", second, resetAt);

      const sel = mgr.selectAccountForTurn("anthropic");

      expect(sel.ok, `mode=${mode}`).toBe(false);
      if (!sel.ok) expect(sel.reason).toBe("all_exhausted");
    }
  });

  it("rejects an unrecognized stored mode instead of routing on it", () => {
    // A hand-edited config must not reach the routing path as an unknown value.
    // Falling back to the default is the only behavior that keeps turns running.
    store.setSelectionMode("anthropic", "sub", "balanced");
    (store as unknown as { data: { accountSelectionMode: Record<string, string> } }).data
      .accountSelectionMode["anthropic:sub"] = "round-robin";

    expect(store.getSelectionMode("anthropic", "sub")).toBe("strict");
  });
});

describe("markAccountUsed", () => {
  let root: string;
  let store: CredentialStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-mark-used-"));
    store = new CredentialStore(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stamps the account and persists it", () => {
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    const acct = mgr.create("anthropic", "First");

    // The field exists on the type but nothing wrote it before req 21, so this
    // assertion is what keeps `balanced` from silently degrading to a no-op
    // sort over `undefined`.
    expect(mgr.get("anthropic", acct.id)?.lastUsedAt).toBeUndefined();
    mgr.markAccountUsed("anthropic", acct.id);
    expect(mgr.get("anthropic", acct.id)?.lastUsedAt).toBeGreaterThan(0);

    // Survives a reload: the sort key has to outlive the process, or a restart
    // would re-cluster every new session onto the same account.
    const reloaded = new ProviderAccountManager({
      credentialsDir: root,
      credentialStore: new CredentialStore(root),
    });
    expect(reloaded.get("anthropic", acct.id)?.lastUsedAt).toBeGreaterThan(0);
  });

  it("separates stamps made within the same millisecond", () => {
    // `Date.now()` is millisecond-granular, so a burst of sessions pinning
    // together would otherwise tie — and a tie falls back to priority order,
    // handing the whole burst to one account. Burst-safety is the reason LRU
    // was chosen over ranking by polled quota, so losing it here would remove
    // the justification for the design.
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    const a = mgr.create("anthropic", "First");
    const b = mgr.create("anthropic", "Second");

    mgr.markAccountUsed("anthropic", a.id);
    mgr.markAccountUsed("anthropic", b.id);

    const stampA = mgr.get("anthropic", a.id)?.lastUsedAt ?? 0;
    const stampB = mgr.get("anthropic", b.id)?.lastUsedAt ?? 0;
    expect(stampB).toBeGreaterThan(stampA);
  });

  it("is a no-op for an account that no longer exists", () => {
    // Deleted mid-turn. Failing a turn over a bookkeeping write would be worse
    // than a stale sort key.
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    expect(() => mgr.markAccountUsed("anthropic", "gone")).not.toThrow();
  });
});
