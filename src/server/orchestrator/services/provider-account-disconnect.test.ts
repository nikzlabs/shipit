import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager, providerAccountCredentialRoot } from "../provider-account-manager.js";
import { SessionManager } from "../sessions.js";
import { createTestDatabaseManager } from "../integration_tests/test-helpers.js";
import { writeSessionAccountMarker, readSessionAccountMarker } from "../session-credentials.js";
import { deleteProviderAccount } from "./settings.js";
import type { SessionRunnerRegistry } from "../session-runner.js";

/**
 * docs/260 §6 (reqs 2, 3, 13) — disconnecting an account.
 *
 * There is no pinning any more, so disconnect never asks where sessions should
 * move and never reports "pinned" ones (req 3). What it must still do:
 * refuse while a live process on the account is running a turn or holds
 * background work (req 13 + the 2026-08-03 no-rewrite-under-a-live-turn
 * decision), kill idle resident processes on the account, and remove each
 * session's recorded COPY of the account's credentials — found by the
 * session's own marker, never by a session row.
 */
describe("deleteProviderAccount", () => {
  let root: string;
  let accounts: ProviderAccountManager;
  let sessions: SessionManager;

  interface FakeRunner {
    sessionId: string;
    running: boolean;
    backgroundWorkDescriptions: string[];
    residentRoute: { kind: "account" | "reserved"; id: string } | undefined;
    killed: boolean;
    cleared: boolean;
  }
  let runners: Map<string, FakeRunner>;

  const addRunner = (
    sessionId: string,
    over: Partial<Omit<FakeRunner, "sessionId" | "killed" | "cleared">> = {},
  ): FakeRunner => {
    const runner: FakeRunner = {
      sessionId,
      running: false,
      backgroundWorkDescriptions: [],
      residentRoute: undefined,
      killed: false,
      cleared: false,
      ...over,
    };
    runners.set(sessionId, runner);
    return runner;
  };

  const registry = () => ({
    ids: () => [...runners.keys()],
    get: (id: string) => {
      const fake = runners.get(id);
      if (!fake) return undefined;
      return {
        sessionId: fake.sessionId,
        running: fake.running,
        backgroundWorkDescriptions: fake.backgroundWorkDescriptions,
        residentRoute: fake.residentRoute,
        getAgent: () => (fake.residentRoute ? { kill: () => { fake.killed = true; } } : null),
        setAgent: (agent: unknown) => { if (agent === null) fake.cleared = true; },
      };
    },
  }) as unknown as SessionRunnerRegistry;

  /** The per-session copy of the account's token — what the CLI actually reads. */
  const sessionTokenPath = (sessionId: string): string =>
    path.join(root, "sessions", sessionId, ".claude", ".credentials.json");

  /** A session whose subtree holds `accountId`'s credentials, per its marker. */
  function seedSessionCopy(sessionId: string, accountId: string, token: string): void {
    sessions.track(sessionId, sessionId);
    sessions.setAgentId(sessionId, "claude");
    fs.mkdirSync(path.dirname(sessionTokenPath(sessionId)), { recursive: true });
    fs.writeFileSync(sessionTokenPath(sessionId), token);
    writeSessionAccountMarker(root, sessionId, "claude", accountId);
  }

  function seedAccount(accountId: string, token: string): void {
    const accountRoot = providerAccountCredentialRoot(root, "claude", accountId);
    fs.mkdirSync(path.join(accountRoot, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(accountRoot, ".claude", ".credentials.json"), token);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-account-disconnect-"));
    accounts = new ProviderAccountManager({
      credentialsDir: root,
      credentialStore: new CredentialStore(root),
    });
    sessions = new SessionManager(createTestDatabaseManager());
    runners = new Map();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("disconnects and returns only the account list — no pinned-session bookkeeping (req 3)", () => {
    const a = accounts.create("anthropic", "A");
    accounts.setAccountStatus("anthropic", a.id, "ready");

    const result = deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
    });

    expect(result).toEqual({ accounts: [] });
  });

  it("disconnects the last account even when idle sessions hold its copy (req 3)", () => {
    const a = accounts.create("anthropic", "A");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    seedAccount(a.id, "tok-a");
    seedSessionCopy("s1", a.id, "tok-a");
    seedSessionCopy("s2", a.id, "tok-a");

    const result = deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
    });

    expect(result).toEqual({ accounts: [] });
    // The copies are revoked — a "disconnected" session must not keep a
    // working subscription token on disk.
    expect(fs.existsSync(sessionTokenPath("s1"))).toBe(false);
    expect(fs.existsSync(sessionTokenPath("s2"))).toBe(false);
    // And the markers are cleared, so the next turn's identity check
    // reprovisions instead of trusting a stale record.
    expect(readSessionAccountMarker(root, "s1").claude).toBeUndefined();
  });

  it("leaves other accounts' session copies alone", () => {
    const a = accounts.create("anthropic", "A");
    const b = accounts.create("anthropic", "B");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    accounts.setAccountStatus("anthropic", b.id, "ready");
    seedSessionCopy("sa", a.id, "tok-a");
    seedSessionCopy("sb", b.id, "tok-b");

    deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
    });

    expect(fs.existsSync(sessionTokenPath("sa"))).toBe(false);
    expect(fs.existsSync(sessionTokenPath("sb"))).toBe(true);
    expect(readSessionAccountMarker(root, "sb").claude).toBe(b.id);
  });

  it("refuses while a process on the account is running a turn, naming the session", () => {
    const a = accounts.create("anthropic", "A");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    sessions.track("busy", "busy");
    addRunner("busy", { running: true, residentRoute: { kind: "account", id: a.id } });

    expect(() =>
      deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
        credentialsDir: root,
      }),
    ).toThrow(/still working on it/);
    // Nothing was deleted — the account is still there to retry against.
    expect(accounts.list("anthropic").map((x) => x.id)).toContain(a.id);
  });

  it("refuses while a process on the account holds background work (req 13)", () => {
    const a = accounts.create("anthropic", "A");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    sessions.track("consulting", "consulting");
    addRunner("consulting", {
      running: false,
      backgroundWorkDescriptions: ["cross-agent review"],
      residentRoute: { kind: "account", id: a.id },
    });

    expect(() =>
      deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
        credentialsDir: root,
      }),
    ).toThrow(/still working on it/);
    expect(runners.get("consulting")?.killed).toBe(false);
  });

  it("kills an IDLE resident process on the account before deleting", () => {
    const a = accounts.create("anthropic", "A");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    sessions.track("idle", "idle");
    const idle = addRunner("idle", { residentRoute: { kind: "account", id: a.id } });

    deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
    });

    expect(idle.killed).toBe(true);
    expect(idle.cleared).toBe(true);
  });

  it("does not touch a busy process on a DIFFERENT account", () => {
    const a = accounts.create("anthropic", "A");
    const b = accounts.create("anthropic", "B");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    accounts.setAccountStatus("anthropic", b.id, "ready");
    sessions.track("other", "other");
    const other = addRunner("other", {
      running: true,
      residentRoute: { kind: "account", id: b.id },
    });

    const result = deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
      credentialsDir: root,
    });

    expect(result.accounts.map((x) => x.id)).toEqual([b.id]);
    expect(other.killed).toBe(false);
  });

  it("identifies a re-adopted process by the session marker when the stamp is missing", () => {
    // After an orchestrator restart, a surviving process may not have its
    // residentRoute recovered yet; the subtree marker is the fallback identity.
    const a = accounts.create("anthropic", "A");
    accounts.setAccountStatus("anthropic", a.id, "ready");
    seedSessionCopy("adopted", a.id, "tok-a");
    addRunner("adopted", { running: true, residentRoute: undefined });

    expect(() =>
      deleteProviderAccount(accounts, sessions, registry(), "claude", a.id, {
        credentialsDir: root,
      }),
    ).toThrow(/still working on it/);
  });
});
