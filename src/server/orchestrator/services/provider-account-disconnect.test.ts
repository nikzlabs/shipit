import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager, providerAccountCredentialRoot } from "../provider-account-manager.js";
import { SessionManager } from "../sessions.js";
import { createTestDatabaseManager } from "../integration_tests/test-helpers.js";
import { deleteProviderAccount } from "./settings.js";
import type { SessionRunnerRegistry } from "../session-runner.js";

/**
 * docs/150 — disconnecting an account that sessions are pinned to.
 *
 * The interesting cases are all about what happens to those sessions: refusing
 * outright would strand them, and deleting silently would leave them unable to
 * take another turn. The account-switch transition (req 9) turns the refusal
 * into a choice, so these tests pin down when it asks, when it moves, and when
 * it still says no.
 */
describe("deleteProviderAccount", () => {
  let root: string;
  let accounts: ProviderAccountManager;
  let sessions: SessionManager;
  let runningSessionIds: Set<string>;

  const registry = () => ({
    get: (id: string) => (runningSessionIds.has(id) ? { running: true, getAgent: () => null, setAgent: () => {} } : undefined),
  }) as unknown as SessionRunnerRegistry;

  function seedAccount(accountId: string, token: string): void {
    const accountRoot = providerAccountCredentialRoot(root, "claude", accountId);
    fs.mkdirSync(path.join(accountRoot, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(accountRoot, ".claude", ".credentials.json"), token);
  }

  function pinSession(id: string, accountId: string): void {
    sessions.track(id, id);
    sessions.setAgentId(id, "claude");
    sessions.setProviderRoute(id, "account", accountId);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-account-disconnect-"));
    accounts = new ProviderAccountManager({
      credentialsDir: root,
      credentialStore: new CredentialStore(root),
    });
    sessions = new SessionManager(createTestDatabaseManager());
    runningSessionIds = new Set();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("disconnects an account no session is pinned to", () => {
    const a = accounts.create("claude", "A");
    accounts.setAccountStatus("claude", a.id, "ready");

    const result = deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
    });

    expect(result.switchedSessionIds).toEqual([]);
    expect(accounts.list("claude")).toEqual([]);
  });

  it("asks for a replacement, naming the usable ones, instead of stranding pinned sessions", () => {
    const a = accounts.create("claude", "A");
    const b = accounts.create("claude", "B");
    accounts.setAccountStatus("claude", a.id, "ready");
    accounts.setAccountStatus("claude", b.id, "ready");
    pinSession("s1", a.id);

    expect(() => deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
    })).toThrow(new RegExp(`1 session\\(s\\).*${b.id}`));
    // Nothing was deleted — the account is still there to retry against.
    expect(accounts.list("claude").map((x) => x.id)).toContain(a.id);
  });

  /**
   * req 23 — the last account is disconnectable. This branch used to 409 with
   * "there is no other connected claude account to move them to", which no
   * amount of user action could satisfy short of connecting an account solely
   * to disconnect another.
   */
  it("disconnects the last account even with sessions pinned to it, reporting them", () => {
    const a = accounts.create("claude", "A");
    accounts.setAccountStatus("claude", a.id, "ready");
    pinSession("s1", a.id);
    pinSession("s2", a.id);

    const result = deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
    });

    expect(accounts.list("claude")).toEqual([]);
    expect(result.switchedSessionIds).toEqual([]);
    expect(result.strandedSessionIds.sort()).toEqual(["s1", "s2"]);
    // The route is left pointing at the gone account rather than rewritten:
    // that reads unusable, which is the same recovery path provider-wide
    // sign-out relies on.
    expect(sessions.get("s1")?.providerRouteId).toBe(a.id);
    expect(accounts.isRouteUsableForTurn("claude", { kind: "account", id: a.id })).toBe(false);
  });

  it("disconnects when the only other account is not connected yet", () => {
    const a = accounts.create("claude", "A");
    const b = accounts.create("claude", "B");
    accounts.setAccountStatus("claude", a.id, "ready");
    // B exists but never finished signing in, so it is not somewhere a pinned
    // session can be moved to — same dead end as having no second account.
    accounts.setAccountStatus("claude", b.id, "auth_failed");
    pinSession("s1", a.id);

    const result = deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
    });

    expect(result.strandedSessionIds).toEqual(["s1"]);
    expect(accounts.list("claude").map((x) => x.id)).toEqual([b.id]);
  });

  it("still asks rather than stranding when a replacement does exist", () => {
    const a = accounts.create("claude", "A");
    const b = accounts.create("claude", "B");
    accounts.setAccountStatus("claude", a.id, "ready");
    accounts.setAccountStatus("claude", b.id, "ready");
    pinSession("s1", a.id);

    expect(() => deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
    })).toThrow(/Choose a replacement account/);
    expect(accounts.list("claude").map((x) => x.id)).toContain(a.id);
  });

  it("moves every pinned session to the replacement, then disconnects", () => {
    const a = accounts.create("claude", "A");
    const b = accounts.create("claude", "B");
    accounts.setAccountStatus("claude", a.id, "ready");
    accounts.setAccountStatus("claude", b.id, "ready");
    seedAccount(a.id, "token-a");
    seedAccount(b.id, "token-b");
    pinSession("s1", a.id);
    pinSession("s2", a.id);
    // An unrelated session on B must not be disturbed.
    pinSession("s3", b.id);

    const result = deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
      replacementAccountId: b.id,
    });

    expect(result.switchedSessionIds.sort()).toEqual(["s1", "s2"]);
    expect(sessions.get("s1")?.providerRouteId).toBe(b.id);
    expect(sessions.get("s2")?.providerRouteId).toBe(b.id);
    expect(sessions.get("s3")?.providerRouteId).toBe(b.id);
    expect(accounts.list("claude").map((x) => x.id)).toEqual([b.id]);
    // The moved sessions really did get B's credentials on disk.
    expect(
      fs.readFileSync(path.join(root, "sessions", "s1", ".claude", ".credentials.json"), "utf-8"),
    ).toBe("token-b");
  });

  it("refuses while a pinned session is running, replacement or not", () => {
    const a = accounts.create("claude", "A");
    const b = accounts.create("claude", "B");
    accounts.setAccountStatus("claude", a.id, "ready");
    accounts.setAccountStatus("claude", b.id, "ready");
    seedAccount(b.id, "token-b");
    pinSession("s1", a.id);
    runningSessionIds.add("s1");

    expect(() => deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
      replacementAccountId: b.id,
    })).toThrow(/while a pinned session is running/);
    expect(sessions.get("s1")?.providerRouteId).toBe(a.id);
  });

  /**
   * req 23 draws the line here: "no matter what" removed the refusal that
   * waiting can never clear, not the one that clears itself when the turn ends.
   * Naming the sessions is what makes it a wait rather than a dead end.
   */
  it("still refuses a running pinned session on the last account, naming it", () => {
    const a = accounts.create("claude", "A");
    accounts.setAccountStatus("claude", a.id, "ready");
    pinSession("s1", a.id);
    runningSessionIds.add("s1");

    expect(() => deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
    })).toThrow(/"s1".*Let the turn finish or stop it/s);
    expect(accounts.list("claude").map((x) => x.id)).toEqual([a.id]);
  });

  it("rejects a replacement that is the account being disconnected", () => {
    const a = accounts.create("claude", "A");
    accounts.setAccountStatus("claude", a.id, "ready");
    pinSession("s1", a.id);

    expect(() => deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
      replacementAccountId: a.id,
    })).toThrow(/must differ/);
  });

  it("ignores archived sessions when deciding whether anything is pinned", () => {
    const a = accounts.create("claude", "A");
    accounts.setAccountStatus("claude", a.id, "ready");
    pinSession("s1", a.id);
    sessions.archive("s1");

    const result = deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
    });

    expect(result.switchedSessionIds).toEqual([]);
    expect(accounts.list("claude")).toEqual([]);
  });
});
