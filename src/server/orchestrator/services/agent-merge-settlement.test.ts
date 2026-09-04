import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AgentMergeClaimStore, currentTurnId } from "../agent-merge-claims.js";
import { settleAgentMerge, reconcileAgentMergeClaims, activeTurnIdFor } from "./agent-merge-settlement.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { TerminalPrFacts } from "../github-auth-prs.js";

/**
 * docs/287-agent-merge-per-repo §4 — settling a merge, and recovering one whose
 * outcome was never learned.
 *
 * The two hazards these guard are asymmetric. Settling something that did not
 * merge marks a session shipped when it is not; failing to settle something that
 * DID merge leaves the agent's next `shipit branch reset-to-base` reading
 * `not-merged` for work that is already on the base branch.
 */

const SESSION = "s1";
const REMOTE = "https://github.com/acme/shipit.git";
const REPO_ID = "github:acme/shipit";

let dbManager: DatabaseManager;
let sessions: SessionManager;
let chatHistoryManager: ChatHistoryManager;
let claims: AgentMergeClaimStore;

function facts(over: Partial<TerminalPrFacts> = {}): TerminalPrFacts {
  return {
    url: "https://github.com/acme/shipit/pull/7",
    number: 7,
    base: "main",
    title: "A pull request",
    body: "",
    state: "closed",
    merged_at: "2026-09-04T12:00:00Z",
    merge_commit_sha: "merge-sha",
    head_sha: "sha-head",
    head_ref: "shipit/feature",
    additions: 1,
    deletions: 0,
    ...over,
  };
}

function poller(result: TerminalPrFacts | null = facts()) {
  return {
    promoteMergedPrByNumber: vi.fn(async () => result),
  } as unknown as PrStatusPoller;
}

function registry(runner: { running?: boolean; agentBusy?: boolean; turnEpoch?: number } | null) {
  return { get: () => runner ?? undefined } as unknown as SessionRunnerRegistry;
}

function deps(over: { prStatusPoller?: PrStatusPoller; runnerRegistry?: SessionRunnerRegistry } = {}) {
  return {
    claims,
    sessionManager: sessions,
    chatHistoryManager,
    prStatusPoller: over.prStatusPoller ?? poller(),
    ...(over.runnerRegistry ? { runnerRegistry: over.runnerRegistry } : {}),
  };
}

function claimOne(over: { prNumber?: number; expectedSha?: string } = {}) {
  const claim = {
    sessionId: SESSION,
    repoId: REPO_ID,
    prNumber: over.prNumber ?? 7,
    expectedSha: over.expectedSha ?? "sha-head",
    turnId: currentTurnId(1),
  };
  claims.claim(claim);
  return { ...claim, state: "merging" as const, createdAt: new Date().toISOString() };
}

function notices(): string[] {
  return chatHistoryManager.load(SESSION)
    .map((m) => (m as { text?: string }).text ?? "")
    .filter((t) => t.length > 0);
}

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  sessions = new SessionManager(dbManager);
  chatHistoryManager = new ChatHistoryManager(dbManager);
  claims = new AgentMergeClaimStore(dbManager);
  sessions.track(SESSION, "A session");
  sessions.setRemoteUrl(SESSION, REMOTE);
  sessions.recordPrProvenance(SESSION, 7, REPO_ID);
});

afterEach(() => {
  dbManager.close();
});

describe("settleAgentMerge", () => {
  it("promotes the pull request, records the merge, and releases the claim", async () => {
    const claim = claimOne();
    const p = poller();
    const out = await settleAgentMerge(deps({ prStatusPoller: p }), claim, { witnessed: true });

    expect(out).toEqual({ result: "settled", merged: true });
    // Addressed by NUMBER — a branch-addressed lookup answers about the wrong
    // pull request after a re-arm or an unarchive in the same repository.
    expect(p.promoteMergedPrByNumber).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, owner: "acme", repo: "shipit", prNumber: 7 }),
    );
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join("\n")).toContain("Merged pull request #7");
  });

  it("says only what it can prove when the merge was not witnessed", async () => {
    // A user, the PR card, or GitHub's own auto-merge could have landed the same
    // commit while ShipIt was not looking. `merge-attribution.ts` documents that
    // this race cannot honestly name the performer.
    const claim = claimOne();
    await settleAgentMerge(deps(), claim, { witnessed: false });

    const text = notices().join("\n");
    expect(text).toContain("is now merged");
    expect(text).not.toContain("Merged pull request #7");
  });

  it("carries the stable natural identity into the record", async () => {
    const claim = claimOne();
    await settleAgentMerge(deps(), claim, { witnessed: true });
    expect(notices().join("\n")).toContain("agent-merge:github:acme/shipit#7@sha-head");
  });

  it("drops the claim without recording when the pull request is still open", async () => {
    // Resolved from the claim's own tuple, never from the shape of an error.
    const claim = claimOne();
    const out = await settleAgentMerge(
      deps({ prStatusPoller: poller(facts({ merged_at: null, state: "open" })) }),
      claim, { witnessed: false },
    );
    expect(out).toEqual({ result: "not-merged" });
    expect(claims.get(SESSION)).toBeNull();
    expect(notices()).toEqual([]);
  });

  it("keeps the claim when GitHub does not answer", async () => {
    const claim = claimOne();
    const out = await settleAgentMerge(deps({ prStatusPoller: poller(null) }), claim, { witnessed: true });
    expect(out).toMatchObject({ result: "deferred" });
    // The row is the only evidence there is; a transient failure must not spend it.
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("does not write session state once the session's pull request has moved on", async () => {
    // Both halves of the tuple matter: `remoteUrl` is rewritten in place when
    // `origin` changes, and pull-request numbers coincide across repositories.
    const claim = claimOne();
    sessions.recordPrProvenance(SESSION, 9, REPO_ID);
    const p = poller();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await settleAgentMerge(deps({ prStatusPoller: p }), claim, { witnessed: true });

    expect(out).toMatchObject({ result: "deferred" });
    expect(p.promoteMergedPrByNumber).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
    // The session is left alone, but the merge is not dropped SILENTLY: this is
    // the one path where a merge ShipIt may have performed has nowhere in the
    // transcript to go (cross-agent review finding).
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n"))
      .toContain("agent-merge:github:acme/shipit#7@sha-head");
  });

  // The three states the review found could be resolved wrongly.
  it("refuses to record a merge that landed at a DIFFERENT commit", async () => {
    // A pull request can be force-pushed and merged at another head between an
    // indeterminate attempt and this read. `merged_at` alone cannot tell that
    // apart from our own commit merging, and recording the claimed commit would
    // be a false record AND anchor the session's reset on the wrong commit.
    const claim = claimOne();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await settleAgentMerge(
      deps({ prStatusPoller: poller(facts({ head_sha: "somebody-elses-commit" })) }),
      claim, { witnessed: false },
    );

    expect(out).toEqual({ result: "not-merged" });
    expect(notices()).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("not the claimed commit");
  });

  it("still settles a WITNESSED merge whose head reads differently afterwards", async () => {
    // A witnessed merge was pinned to `expected_sha` by the REST call, so GitHub
    // already enforced the match — and a repository that deletes the branch can
    // legitimately report a different head afterwards.
    const claim = claimOne();
    const out = await settleAgentMerge(
      deps({ prStatusPoller: poller(facts({ head_sha: null })) }),
      claim, { witnessed: true },
    );
    expect(out).toEqual({ result: "settled", merged: true });
  });

  it("never downgrades a `settling` claim to not-merged", async () => {
    // The row reached `settling` because a merge response CAME BACK. GitHub's
    // read-after-write is not instant, so a follow-up GET that still says open
    // is a stale read — deleting the row on it destroys the durable proof.
    const claim = claimOne();
    claims.markSettling(SESSION, "sha-head");
    const out = await settleAgentMerge(
      deps({ prStatusPoller: poller(facts({ merged_at: null, state: "open" })) }),
      { ...claim, state: "settling" }, { witnessed: true },
    );

    expect(out).toMatchObject({ result: "deferred" });
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("stands down when the turn that claimed the merge has ended", async () => {
    // The merge and the settlement are separated by a GitHub round trip. A turn
    // that ended in between no longer owns the session state this would write.
    const claim = claimOne();
    const p = poller();
    const out = await settleAgentMerge(
      deps({ prStatusPoller: p, runnerRegistry: registry({ running: true, turnEpoch: 99 }) }),
      claim, { witnessed: true },
    );

    expect(out).toMatchObject({ result: "deferred" });
    expect(p.promoteMergedPrByNumber).not.toHaveBeenCalled();
  });

  it("re-asks whether it is safe to settle, after the caller's own await", async () => {
    // A caller that awaited I/O to get here cannot rely on a check it made
    // before that await — a turn may have started during it.
    const claim = claimOne();
    const p = poller();
    const out = await settleAgentMerge(deps({ prStatusPoller: p }), claim, {
      witnessed: false,
      stillSafeToSettle: () => false,
    });

    expect(out).toMatchObject({ result: "deferred" });
    expect(p.promoteMergedPrByNumber).not.toHaveBeenCalled();
  });

  it("does not write session state after origin moved to another repository", async () => {
    const claim = claimOne();
    sessions.setRemoteUrl(SESSION, "https://github.com/acme/other.git");
    const p = poller();
    const out = await settleAgentMerge(deps({ prStatusPoller: p }), claim, { witnessed: true });
    expect(out).toMatchObject({ result: "deferred" });
    expect(p.promoteMergedPrByNumber).not.toHaveBeenCalled();
  });

  it("records once, not once per settlement attempt", async () => {
    const claim = claimOne();
    await settleAgentMerge(deps(), claim, { witnessed: true });
    // The claim is gone, so a repeat has nothing to settle — which is what makes
    // the record fire once rather than once per recovery.
    await settleAgentMerge(deps(), claim, { witnessed: true });
    expect(notices().filter((t) => t.includes("agent-merge:"))).toHaveLength(1);
  });
});

describe("reconcileAgentMergeClaims", () => {
  it("settles a surviving claim when the session is idle", async () => {
    claimOne();
    await reconcileAgentMergeClaims(deps({ runnerRegistry: registry(null) }));
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join("\n")).toContain("is now merged");
  });

  it("stands down while a turn is running on that session", async () => {
    // Reattachment returns while the adopted turn keeps running, still editing
    // and still pushing. Settling behind its back would mark the session merged
    // and delete its remote branch mid-turn.
    claimOne();
    const p = poller();
    await reconcileAgentMergeClaims(
      deps({ prStatusPoller: p, runnerRegistry: registry({ running: true, turnEpoch: 2 }) }),
    );
    expect(p.promoteMergedPrByNumber).not.toHaveBeenCalled();
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("stands down for post-turn work too, not only a running agent", async () => {
    // `agentBusy` covers the commit, the debounced push and a backgrounded
    // consult — all of which still produce commits to push.
    claimOne();
    const p = poller();
    await reconcileAgentMergeClaims(
      deps({ prStatusPoller: p, runnerRegistry: registry({ running: false, agentBusy: true }) }),
    );
    expect(p.promoteMergedPrByNumber).not.toHaveBeenCalled();
  });

  it("keeps going when one claim throws", async () => {
    claimOne();
    const p = {
      promoteMergedPrByNumber: vi.fn(async () => { throw new Error("GitHub down"); }),
    } as unknown as PrStatusPoller;
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(reconcileAgentMergeClaims(deps({ prStatusPoller: p }))).resolves.toBeUndefined();
    // A throw must not spend the row — the merge may still have happened.
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("can be scoped to one session", async () => {
    claimOne();
    const p = poller();
    await reconcileAgentMergeClaims(deps({ prStatusPoller: p }), { sessionId: "someone-else" });
    expect(p.promoteMergedPrByNumber).not.toHaveBeenCalled();
    expect(claims.get(SESSION)).not.toBeNull();
  });
});

describe("activeTurnIdFor", () => {
  it("answers null when nothing is running, so the merge route refuses", () => {
    expect(activeTurnIdFor(registry(null), SESSION)).toBeNull();
    expect(activeTurnIdFor(registry({ running: false, turnEpoch: 4 }), SESSION)).toBeNull();
  });

  it("identifies the running turn", () => {
    expect(activeTurnIdFor(registry({ running: true, turnEpoch: 4 }), SESSION))
      .toBe(currentTurnId(4));
  });
});
