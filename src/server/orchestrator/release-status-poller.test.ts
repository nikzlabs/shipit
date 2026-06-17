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
    pr: null as { state: "open" | "closed"; merged: boolean } | null,
    checkStatusCalls: 0,
    releaseCalls: 0,
    prCalls: 0,
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
    async viewPullRequest() {
      state.prCalls++;
      return state.pr;
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

interface CardSnapshot { phase: string; tag: string; cardId: string; alreadyReleased?: boolean; mechanism?: string }

function makePoller() {
  const { gh, state } = makeFakeGitHub();
  // Every card transition is now routed through the single `onCard` sink (which
  // the orchestrator wires to chat-history persist + the `release_card` WS).
  const cards: CardSnapshot[] = [];
  const poller = new ReleaseStatusPoller({
    githubAuth: gh,
    onCard: (card) => cards.push(card as unknown as CardSnapshot),
    runnerRegistry: makeFakeRegistry(),
  });
  return { poller, state, cards };
}

/** Last card emitted through `onCard` (the phases the tests assert on). */
function lastCard(cards: CardSnapshot[]): CardSnapshot | undefined {
  return cards.length > 0 ? cards[cards.length - 1] : undefined;
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
    expect(lastCard(ctx.cards)?.phase).toBe("proposed");
    expect(lastCard(ctx.cards)?.cardId).toBe("release:s1:v0.3.0");
    expect(ctx.state.checkStatusCalls).toBe(0);
    expect(ctx.state.releaseCalls).toBe(0);
  });

  it("propose carries the mechanism onto the card (docs/214)", async () => {
    const ctx = makePoller();
    poller = ctx.poller;
    poller.propose("s1", REPO, { version: "0.3.0", tag: "v0.3.0", prerelease: false, mechanism: "release-branch" });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastCard(ctx.cards)?.mechanism).toBe("release-branch");
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

  it("markPrOpened sets a pr_open card and polls the PR (docs/214)", async () => {
    const ctx = makePoller();
    poller = ctx.poller;
    ctx.state.pr = { state: "open", merged: false };
    poller.markPrOpened("s1", REPO, {
      version: "0.3.0", tag: "v0.3.0", prerelease: false,
      prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42", releaseBranch: "stable",
    });
    await vi.advanceTimersByTimeAsync(0);
    const card = poller.getStatus("s1");
    expect(card?.phase).toBe("pr_open");
    expect(card?.prNumber).toBe(42);
    expect(card?.releaseBranch).toBe("stable");
    expect(ctx.state.prCalls).toBeGreaterThan(0);
    // No Release polling while the PR is still open.
    expect(ctx.state.releaseCalls).toBe(0);
  });

  it("pr_open → pr_merged → released once the PR merges and CI publishes", async () => {
    const ctx = makePoller();
    poller = ctx.poller;
    ctx.state.pr = { state: "open", merged: true }; // already merged when first polled
    ctx.state.release = {
      name: "v0.3.0", body: "notes", htmlUrl: "https://github.com/owner/repo/releases/tag/v0.3.0",
      prerelease: false, publishedAt: "2026-06-03T00:00:00Z", tagName: "v0.3.0",
    };
    poller.markPrOpened("s1", REPO, {
      version: "0.3.0", tag: "v0.3.0", prerelease: false,
      prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42", releaseBranch: "stable",
    });
    await vi.advanceTimersByTimeAsync(0);
    // merge detected → immediate re-poll picks up the published Release.
    expect(poller.getStatus("s1")?.phase).toBe("released");
  });

  it("pr_open → failed when the PR is closed without merging", async () => {
    const ctx = makePoller();
    poller = ctx.poller;
    ctx.state.pr = { state: "closed", merged: false };
    poller.markPrOpened("s1", REPO, {
      version: "0.3.0", tag: "v0.3.0", prerelease: false,
      prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42", releaseBranch: "stable",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus("s1")?.phase).toBe("failed");
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

  it("cancel collapses the card to a persisted `cancelled` state (not a removal)", () => {
    const ctx = makePoller();
    poller = ctx.poller;
    poller.propose("s1", REPO, { version: "0.3.0", tag: "v0.3.0", prerelease: false });
    poller.cancel("s1");
    // The card stays — collapsed to terminal `cancelled` — so the decision is
    // persisted in the transcript and survives a reload, rather than vanishing.
    expect(poller.getStatus("s1")?.phase).toBe("cancelled");
    const last = lastCard(ctx.cards);
    expect(last?.phase).toBe("cancelled");
    expect(last?.cardId).toBe("release:s1:v0.3.0");
  });

  it("cancel is a no-op when nothing was proposed", () => {
    const ctx = makePoller();
    poller = ctx.poller;
    poller.cancel("s1");
    expect(poller.getStatus("s1")).toBeUndefined();
    expect(ctx.cards).toHaveLength(0);
  });
});
