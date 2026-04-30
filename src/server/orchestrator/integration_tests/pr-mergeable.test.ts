/**
 * Integration tests for feature 113 — surfacing GitHub-reported mergeable state.
 *
 * Verifies the wire-format end-to-end: GraphQL `MERGEABLE` / `CONFLICTING` /
 * `UNKNOWN` enum values flow through the poller and out over the SSE broadcast
 * as the tri-state string the client UI now reads.
 *
 * The downstream rebase-trigger flow that the "Resolve conflicts" button kicks
 * off is already covered by rebase-flow.test.ts; this test focuses on the new
 * data path that lets the UI know the conflict exists in the first place.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { PrStatusPoller } from "../pr-status-poller.js";
import {
  StubGitHubAuthManager,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";

let tmpDir: string;
let githubAuth: StubGitHubAuthManager;
let sessionId: string;
let sessionDir: string;
let sessionManager: SessionManager;
let prStatusPoller: PrStatusPoller;
let dbManager: DatabaseManager;
// Typed as the SseBroadcast signature so it can be passed straight into the
// poller without an `as never` cast.
let sseBroadcast: ReturnType<typeof vi.fn> & ((event: string, data: unknown) => void);

function makeGraphqlPayload(mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN") {
  return {
    data: {
      repository: {
        pullRequests: {
          nodes: [{
            number: 42,
            title: "Test PR",
            url: "https://github.com/test-user/test-repo/pull/42",
            state: "OPEN",
            mergeable,
            autoMergeRequest: null,
            headRefName: "shipit/test-feature",
            baseRefName: "main",
            additions: 10,
            deletions: 5,
            commits: {
              nodes: [{
                commit: {
                  oid: "abc123",
                  statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
                },
              }],
            },
          }],
        },
      },
    },
  };
}

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-pr-mergeable-test-");
  githubAuth = new StubGitHubAuthManager();
  sseBroadcast = vi.fn() as typeof sseBroadcast;

  sessionId = crypto.randomUUID();
  sessionDir = path.join(tmpDir, "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const git = new GitManager(sessionDir);
  await git.init();
  fs.writeFileSync(path.join(sessionDir, "README.md"), "# Test\n");
  execSync("git add README.md && git commit -m 'initial'", {
    cwd: sessionDir,
    env: { ...process.env, HOME: tmpDir },
  });
  await git.addRemote("origin", "https://github.com/test-user/test-repo.git");
  execSync("git checkout -b shipit/test-feature", {
    cwd: sessionDir,
    env: { ...process.env, HOME: tmpDir },
  });

  sessionManager = new SessionManager(dbManager);
  sessionManager.track(sessionId, "Test session", sessionDir);
  sessionManager.setBranch(sessionId, "shipit/test-feature");
  sessionManager.setRemoteUrl(sessionId, "https://github.com/test-user/test-repo.git");
  await githubAuth.setToken("test-token");

  prStatusPoller = new PrStatusPoller({
    githubAuth: githubAuth as never,
    sessionManager,
    sseBroadcast,
  });
});

afterEach(async () => {
  prStatusPoller.destroy();
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Pull the latest broadcast `pr_status` payload for a session out of the spy.
 * The poller may broadcast multiple times during the test lifetime; we want
 * the most recent so we can assert on the post-poll state.
 */
function latestPrStatusPayload(sessionId: string) {
  const calls = sseBroadcast.mock.calls.filter(
    ([type, payload]) =>
      type === "pr_status" &&
      Array.isArray(payload?.updates) &&
      payload.updates.some((u: { sessionId: string }) => u.sessionId === sessionId),
  );
  if (calls.length === 0) return null;
  const last = calls[calls.length - 1][1] as { updates: { sessionId: string; mergeable: string }[] };
  return last.updates.find((u) => u.sessionId === sessionId) ?? null;
}

describe("PR mergeable state — broadcast wire format", () => {
  it("broadcasts mergeable: \"mergeable\" when GitHub reports MERGEABLE", async () => {
    githubAuth.setGraphqlResult(makeGraphqlPayload("MERGEABLE"));
    prStatusPoller.trackSession(sessionId, "https://github.com/test-user/test-repo.git");

    // Initial poll fires immediately on trackSession; allow it to settle.
    await new Promise((r) => setTimeout(r, 100));

    const update = latestPrStatusPayload(sessionId);
    expect(update?.mergeable).toBe("mergeable");
  });

  it("broadcasts mergeable: \"conflicting\" when GitHub reports CONFLICTING", async () => {
    // This is the case that motivated feature 113 — base branch moved
    // forward after the PR was pushed, GitHub flips mergeability to
    // CONFLICTING, and the new tri-state lets the UI gate the merge button
    // and surface the Resolve conflicts affordance.
    githubAuth.setGraphqlResult(makeGraphqlPayload("CONFLICTING"));
    prStatusPoller.trackSession(sessionId, "https://github.com/test-user/test-repo.git");

    await new Promise((r) => setTimeout(r, 100));

    const update = latestPrStatusPayload(sessionId);
    expect(update?.mergeable).toBe("conflicting");
  });

  it("broadcasts mergeable: \"unknown\" when GitHub reports UNKNOWN", async () => {
    // The transient post-push state. Distinguishing it from "conflicting"
    // is the entire point of widening the type — the UI must NOT gate the
    // merge button on this value, or it will flicker every push.
    githubAuth.setGraphqlResult(makeGraphqlPayload("UNKNOWN"));
    prStatusPoller.trackSession(sessionId, "https://github.com/test-user/test-repo.git");

    await new Promise((r) => setTimeout(r, 100));

    const update = latestPrStatusPayload(sessionId);
    expect(update?.mergeable).toBe("unknown");
  });
});
