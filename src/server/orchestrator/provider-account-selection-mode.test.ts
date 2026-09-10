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
    const accounts = [account("used", 500), account("fresh")];
    expect(orderForSelectionMode(accounts, "balanced").map((a) => a.id)).toEqual(["fresh", "used"]);
  });

  it("falls back to the user's order when everything ties", () => {
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

    expect(picks).toEqual([first, second, first, second]);
  });

  it("balanced still refuses an exhausted account rather than balancing onto it", () => {
    store.setSelectionMode("anthropic", "sub", "balanced");
    const resetAt = Date.now() + 60 * 60 * 1000;
    const mgr = manager();
    const [first, second] = twoAccounts(mgr);
    mgr.markAccountUsed("anthropic", second);
    mgr.markAccountExhausted("anthropic", first, resetAt);

    const sel = mgr.selectAccountForTurn("anthropic");

    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel.route.id).toBe(second);
  });

  it("fails over identically in both modes, and honours the retry exclusion (req 15)", () => {
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

    expect(mgr.get("anthropic", acct.id)?.lastUsedAt).toBeUndefined();
    mgr.markAccountUsed("anthropic", acct.id);
    expect(mgr.get("anthropic", acct.id)?.lastUsedAt).toBeGreaterThan(0);

    const reloaded = new ProviderAccountManager({
      credentialsDir: root,
      credentialStore: new CredentialStore(root),
    });
    expect(reloaded.get("anthropic", acct.id)?.lastUsedAt).toBeGreaterThan(0);
  });

  it("separates stamps made within the same millisecond", () => {
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
    const mgr = new ProviderAccountManager({ credentialsDir: root, credentialStore: store });
    expect(() => mgr.markAccountUsed("anthropic", "gone")).not.toThrow();
  });
});
