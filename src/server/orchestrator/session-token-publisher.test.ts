/**
 * Unit tests for the docs/153 mid-turn token publisher.
 *
 * The behavior under test is publication LATENCY: a token the session's CLI
 * rotates mid-turn must reach the orchestrator source while the turn is still
 * running, not at turn end. Everything else about the write — in particular the
 * expiry guard that stops a failed-refresh session clobbering a fresher source
 * — must be unchanged, because the publisher calls the same sync-back.
 *
 * Real filesystem + real `fs.watchFile` polling, with the poll/debounce knobs
 * turned down. Fake timers would defeat the point (the poller is the thing
 * being tested), so the tests poll for the expected state with a timeout.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  startTokenWriteBackWatch,
  stopTokenWriteBackWatch,
  stopAllTokenWriteBackWatches,
  hasTokenWriteBackWatch,
} from "./session-token-publisher.js";

/** Fast enough that a test settles quickly, slow enough not to spin. */
const FAST = { pollIntervalMs: 15, debounceMs: 5 } as const;

let tmpDir: string;

function sourceFile(): string {
  return path.join(tmpDir, ".claude", ".credentials.json");
}

function accountSourceFile(accountId: string): string {
  return path.join(
    tmpDir, "provider-accounts", "claude", accountId, ".claude", ".credentials.json",
  );
}

function sessionFile(sessionId = "s1"): string {
  return path.join(tmpDir, "sessions", sessionId, ".claude", ".credentials.json");
}

function writeToken(file: string, expiresAt: number, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { expiresAt, accessToken: `tok-${expiresAt}` }, ...extra }));
}

function readExpiry(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { claudeAiOauth?: { expiresAt?: number } };
  return parsed.claudeAiOauth?.expiresAt ?? null;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Give the poller several cycles to prove that nothing happens. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, FAST.pollIntervalMs * 8 + 50));
}

describe("session token publisher (docs/153 mid-turn publication)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-token-publish-"));
  });

  afterEach(() => {
    stopAllTokenWriteBackWatches();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("publishes a rotation to the source mid-turn, without waiting for turn end", async () => {
    writeToken(sourceFile(), 1_000);
    writeToken(sessionFile(), 1_000);

    startTokenWriteBackWatch({ credentialsDir: tmpDir, sessionId: "s1", agentId: "claude", ...FAST });

    // The session's CLI rotates. No turn-end hook runs.
    writeToken(sessionFile(), 2_000_000_000_000);

    await waitFor(() => readExpiry(sourceFile()) === 2_000_000_000_000);
    // The rotated access token itself made it across, not just the expiry.
    expect(fs.readFileSync(sourceFile(), "utf8")).toContain("tok-2000000000000");
  });

  it("publishes at arm time a rotation stranded by a turn that never reached its end", async () => {
    // Idle cleanup destroyed the container mid-turn, so the turn-end sync-back
    // never ran and the session is holding a rotation the source never saw.
    writeToken(sourceFile(), 1_000);
    writeToken(sessionFile(), 2_000_000_000_000);

    startTokenWriteBackWatch({ credentialsDir: tmpDir, sessionId: "s1", agentId: "claude", ...FAST });

    await waitFor(() => readExpiry(sourceFile()) === 2_000_000_000_000);
  });

  it("preserves the expiry guard: a session token OLDER than the source never clobbers it", async () => {
    writeToken(sourceFile(), 5_000_000_000_000);
    writeToken(sessionFile(), 5_000_000_000_000);

    startTokenWriteBackWatch({ credentialsDir: tmpDir, sessionId: "s1", agentId: "claude", ...FAST });

    // This session FAILED to refresh and fell back to an older token. It must
    // not overwrite the fresher source.
    writeToken(sessionFile(), 3_000_000_000_000);

    await settle();
    expect(readExpiry(sourceFile())).toBe(5_000_000_000_000);
  });

  it("no-ops when the token file changes but the token did not advance (no write storm)", async () => {
    writeToken(sourceFile(), 4_000_000_000_000);
    writeToken(sessionFile(), 4_000_000_000_000);
    const before = fs.readFileSync(sourceFile(), "utf8");

    startTokenWriteBackWatch({ credentialsDir: tmpDir, sessionId: "s1", agentId: "claude", ...FAST });

    // The Claude CLI rewrites `.credentials.json` for reasons other than an
    // OAuth rotation — the `mcpOAuth` key churns during a turn. Same expiry,
    // so nothing may be written back.
    for (let i = 0; i < 5; i++) {
      writeToken(sessionFile(), 4_000_000_000_000, { mcpOAuth: { churn: i } });
      await new Promise((resolve) => setTimeout(resolve, FAST.pollIntervalMs * 2));
    }

    await settle();
    expect(fs.readFileSync(sourceFile(), "utf8")).toBe(before);
  });

  it("routes an account-pinned session's rotation to that account's source, not the legacy root", async () => {
    writeToken(sourceFile(), 1_000);
    writeToken(accountSourceFile("acct-work"), 1_000);
    writeToken(sessionFile(), 1_000);

    startTokenWriteBackWatch({
      credentialsDir: tmpDir, sessionId: "s1", agentId: "claude", accountId: "acct-work", ...FAST,
    });

    writeToken(sessionFile(), 2_000_000_000_000);

    await waitFor(() => readExpiry(accountSourceFile("acct-work")) === 2_000_000_000_000);
    expect(readExpiry(sourceFile())).toBe(1_000);
  });

  it("stops publishing after the watch is stopped", async () => {
    writeToken(sourceFile(), 1_000);
    writeToken(sessionFile(), 1_000);

    startTokenWriteBackWatch({ credentialsDir: tmpDir, sessionId: "s1", agentId: "claude", ...FAST });
    expect(hasTokenWriteBackWatch("s1")).toBe(true);

    stopTokenWriteBackWatch("s1");
    expect(hasTokenWriteBackWatch("s1")).toBe(false);

    writeToken(sessionFile(), 2_000_000_000_000);
    await settle();
    expect(readExpiry(sourceFile())).toBe(1_000);
  });

  it("tears the watch down when the runner is disposed mid-turn", async () => {
    writeToken(sourceFile(), 1_000);
    writeToken(sessionFile(), 1_000);
    const runner = new EventEmitter();

    startTokenWriteBackWatch({
      credentialsDir: tmpDir, sessionId: "s1", agentId: "claude", runner, ...FAST,
    });
    expect(hasTokenWriteBackWatch("s1")).toBe(true);

    // Idle cleanup destroys the container mid-turn: no turn end ever runs, so
    // the runner's own lifecycle event is the only teardown signal.
    runner.emit("disposed");
    expect(hasTokenWriteBackWatch("s1")).toBe(false);

    writeToken(sessionFile(), 2_000_000_000_000);
    await settle();
    expect(readExpiry(sourceFile())).toBe(1_000);
  });

  it("is idempotent for the same session + route, and re-arms on a route change", async () => {
    writeToken(sourceFile(), 1_000);
    writeToken(accountSourceFile("acct-b"), 1_000);
    writeToken(sessionFile(), 1_000);

    startTokenWriteBackWatch({ credentialsDir: tmpDir, sessionId: "s1", agentId: "claude", ...FAST });
    startTokenWriteBackWatch({ credentialsDir: tmpDir, sessionId: "s1", agentId: "claude", ...FAST });
    expect(hasTokenWriteBackWatch("s1")).toBe(true);
    // Still publishing exactly once through the legacy root.
    writeToken(sessionFile(), 2_000_000_000_000);
    await waitFor(() => readExpiry(sourceFile()) === 2_000_000_000_000);

    // A docs/150 account failover repoints the source; the watch must follow.
    startTokenWriteBackWatch({
      credentialsDir: tmpDir, sessionId: "s1", agentId: "claude", accountId: "acct-b", ...FAST,
    });
    writeToken(sessionFile(), 2_000_000_001_000);
    await waitFor(() => readExpiry(accountSourceFile("acct-b")) === 2_000_000_001_000);
  });

  it("publishes a Codex rotation too (JWT-exp freshness)", async () => {
    const codexSource = path.join(tmpDir, ".codex", "auth.json");
    const codexSession = path.join(tmpDir, "sessions", "s1", ".codex", "auth.json");
    const jwt = (exp: number): string =>
      `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
    const write = (file: string, exp: number): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: jwt(exp) } }));
    };
    write(codexSource, 1_000);
    write(codexSession, 1_000);

    startTokenWriteBackWatch({ credentialsDir: tmpDir, sessionId: "s1", agentId: "codex", ...FAST });
    write(codexSession, 2_000_000_000);

    await waitFor(() => fs.readFileSync(codexSource, "utf8") === fs.readFileSync(codexSession, "utf8"));
  });

  it("is a no-op for an agent with no rotating token file", () => {
    startTokenWriteBackWatch({
      credentialsDir: tmpDir, sessionId: "s1", agentId: "nope" as never, ...FAST,
    });
    expect(hasTokenWriteBackWatch("s1")).toBe(false);
  });
});
