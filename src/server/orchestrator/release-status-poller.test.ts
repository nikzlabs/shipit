import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ReleaseStatusPoller,
  RELEASE_POLL_INTERVAL_MS,
} from "./release-status-poller.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";
import type { ReleaseByTag } from "./github-auth-releases.js";

const REPO = "https://github.com/owner/repo";

type Checks = Awaited<ReturnType<GitHubAuthManager["getCheckStatus"]>>;

/** Minimal GitHubAuthManager fake with call counters + configurable results. */
function makeFakeGitHub() {
  const state = {
    authenticated: true,
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 } as Checks,
    release: null as ReleaseByTag | null,
    checkStatusCalls: 0,
    releaseCalls: 0,
  };
  const gh = {
    get authenticated() {
      return state.authenticated;
    },
    async getCheckStatus(): Promise<Checks> {
      state.checkStatusCalls++;
      return state.checks;
    },
    async getReleaseByTag(): Promise<ReleaseByTag | null> {
      state.releaseCalls++;
      return state.release;
    },
  } as unknown as GitHubAuthManager;
  return { gh, state };
}

/** Fake registry exposing one always-viewed runner so the gate stays open. */
function makeFakeRegistry(viewerCount = 1): SessionRunnerRegistry {
  return {
    ids: () => ["viewer"],
    get: (_id: string) => ({ viewerCount, running: false }) as unknown as SessionRunnerInterface,
  } as unknown as SessionRunnerRegistry;
}

function makePoller() {
  const { gh, state } = makeFakeGitHub();
  const events: { event: string; data: { updates: unknown[]; removals?: string[] } }[] = [];
  const poller = new ReleaseStatusPoller({
    githubAuth: gh,
    sseBroadcast: (event, data) => events.push({ event, data: data as { updates: unknown[] } }),
    runnerRegistry: makeFakeRegistry(),
  });
  return { poller, state, events };
}

/** Last release_status card broadcast (phases the test asserts on). */
function lastCard(events: { event: string; data: { updates: unknown[] } }[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const u = events[i].data.updates;
    if (u.length > 0) return u[u.length - 1] as { phase: string; tag: string; alreadyReleased?: boolean };
  }
  return undefined;
}

describe("ReleaseStatusPoller", () => {
  let poller: ReleaseStatusPoller;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    poller?.destroy();
    vi.useRealTimers();
  });

  it("propose sets a proposed card and does not poll", async () => {
    const ctx = makePoller();
    poller = ctx.poller;
    poller.propose("s1", REPO, { version: "0.3.0", tag: "v0.3.0", prerelease: false, bumpType: "minor" });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastCard(ctx.events)?.phase).toBe("proposed");
    expect(ctx.state.checkStatusCalls).toBe(0);
    expect(ctx.state.releaseCalls).toBe(0);
  });

  it("markTagged → gating → released once the Release is published", async () => {
    const ctx = makePoller();
    poller = ctx.poller;
    ctx.state.checks = { state: "success", total: 2, passed: 2, failed: 0, pending: 0 };
    ctx.state.release = {
      name: "v0.3.0", body: "## Features\n- x", htmlUrl: "https://github.com/owner/repo/releases/tag/v0.3.0",
      prerelease: false, publishedAt: "2026-06-03T00:00:00Z", tagName: "v0.3.0",
    };
    poller.markTagged("s1", REPO, { tag: "v0.3.0", version: "0.3.0", prerelease: false, sha: "abc123" });
    await vi.advanceTimersByTimeAsync(0);
    const card = poller.getStatus("s1");
    expect(card?.phase).toBe("released");
    expect(card?.release?.htmlUrl).toContain("releases/tag/v0.3.0");
    expect(card?.notes).toContain("Features");
  });

  it("markTagged → failed when the gate fails and no Release exists", async () => {
    const ctx = makePoller();
    poller = ctx.poller;
    ctx.state.checks = { state: "failure", total: 2, passed: 1, failed: 1, pending: 0 };
    ctx.state.release = null;
    poller.markTagged("s1", REPO, { tag: "v0.3.0", version: "0.3.0", prerelease: false, sha: "abc123" });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus("s1")?.phase).toBe("failed");
  });

  it("stays gating while checks are pending and keeps polling on the fast cadence", async () => {
    const ctx = makePoller();
    poller = ctx.poller;
    ctx.state.checks = { state: "pending", total: 2, passed: 0, failed: 0, pending: 2 };
    ctx.state.release = null;
    poller.markTagged("s1", REPO, { tag: "v0.3.0", version: "0.3.0", prerelease: false, sha: "abc123" });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus("s1")?.phase).toBe("gating");
    const callsAfterInitial = ctx.state.releaseCalls;
    // A fast tick later, an active (gating) card polls again.
    await vi.advanceTimersByTimeAsync(RELEASE_POLL_INTERVAL_MS);
    expect(ctx.state.releaseCalls).toBeGreaterThan(callsAfterInitial);
  });

  it("stops polling once a card is terminal", async () => {
    const ctx = makePoller();
    poller = ctx.poller;
    ctx.state.checks = { state: "success", total: 1, passed: 1, failed: 0, pending: 0 };
    ctx.state.release = {
      name: "v0.3.0", body: "notes", htmlUrl: "https://x/releases/tag/v0.3.0",
      prerelease: false, publishedAt: null, tagName: "v0.3.0",
    };
    poller.markTagged("s1", REPO, { tag: "v0.3.0", version: "0.3.0", prerelease: false, sha: "abc123" });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus("s1")?.phase).toBe("released");
    const callsAfterReleased = ctx.state.releaseCalls;
    await vi.advanceTimersByTimeAsync(RELEASE_POLL_INTERVAL_MS * 3);
    expect(ctx.state.releaseCalls).toBe(callsAfterReleased);
  });

  it("dedups a second session tagging the same {repo, tag}", async () => {
    const ctx = makePoller();
    poller = ctx.poller;
    ctx.state.checks = { state: "success", total: 1, passed: 1, failed: 0, pending: 0 };
    ctx.state.release = {
      name: "v0.3.0", body: "notes", htmlUrl: "https://x/releases/tag/v0.3.0",
      prerelease: false, publishedAt: null, tagName: "v0.3.0",
    };
    poller.markTagged("s1", REPO, { tag: "v0.3.0", version: "0.3.0", prerelease: false, sha: "abc123" });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus("s1")?.phase).toBe("released");

    const releaseCallsBefore = ctx.state.releaseCalls;
    // A different session confirms the same tag — should surface the existing
    // release immediately as "already released", without re-polling.
    poller.markTagged("s2", REPO, { tag: "v0.3.0", version: "0.3.0", prerelease: false, sha: "abc123" });
    await vi.advanceTimersByTimeAsync(0);
    const s2 = poller.getStatus("s2");
    expect(s2?.phase).toBe("released");
    expect(s2?.alreadyReleased).toBe(true);
    expect(ctx.state.releaseCalls).toBe(releaseCallsBefore);
  });

  it("cancel removes the card and broadcasts a removal", () => {
    const ctx = makePoller();
    poller = ctx.poller;
    poller.propose("s1", REPO, { version: "0.3.0", tag: "v0.3.0", prerelease: false });
    poller.cancel("s1");
    expect(poller.getStatus("s1")).toBeUndefined();
    const last = ctx.events[ctx.events.length - 1];
    expect(last.data.removals).toEqual(["s1"]);
  });
});
