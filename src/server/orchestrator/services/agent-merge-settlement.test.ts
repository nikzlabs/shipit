import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AgentMergeClaimStore } from "../agent-merge-claims.js";
import { settleAgentMerge, reconcileAgentMergeClaims, captureTurn } from "./agent-merge-settlement.js";
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

/**
 * A poller fake that PERFORMS the promotion decision rather than standing in for
 * its result.
 *
 * It applies the caller's `guard` in the same place the real
 * `promoteMergedPrByNumber` does — after the GitHub read, before the first write
 * — and records what it promoted in `promoted`. Returning a bare value instead
 * was how several of these tests came to pass against broken orderings: a
 * settlement that promoted first and validated afterwards looked identical to
 * one that validated first, because the fake had no write to observe.
 *
 * `onFetch` runs inside the simulated round trip, which is what makes "a turn
 * started while GitHub was answering" reproducible rather than asserted.
 */
function poller(result: TerminalPrFacts | null = facts(), opts: { onFetch?: () => void } = {}) {
  const promoted: TerminalPrFacts[] = [];
  return {
    promoted,
    promoteMergedPrByNumber: vi.fn(async (args: { guard?: (pr: TerminalPrFacts) => boolean }) => {
      opts.onFetch?.();
      if (!result) return null;
      if (result.merged_at === null && result.state !== "closed") return { pr: result, promoted: false };
      if (args.guard && !args.guard(result)) return { pr: result, promoted: false };
      promoted.push(result);
      return { pr: result, promoted: true };
    }),
    readPrByNumber: vi.fn(async () => {
      opts.onFetch?.();
      return result;
    }),
  } as unknown as PrStatusPoller & { promoted: TerminalPrFacts[] };
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
    method: "merge" as const,
  };
  claims.claim(claim);
  return {
    ...claim, state: "merging" as const, origin: "direct" as const,
    createdAt: new Date().toISOString(),
  };
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

  it("names the pull request and the commit in the record (req 9)", async () => {
    // Req 9: "the record names the pull request". The merge's natural identity
    // stays in the log lines, for correlating a recovery across a restart; the
    // transcript line is written for the user, not for a correlation key.
    const claim = claimOne();
    await settleAgentMerge(deps(), claim, { witnessed: true });
    const text = notices().join("\n");
    expect(text).toContain("#7");
    expect(text).toContain("sha-head".slice(0, 8));
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

  it("records the merge in the transcript when the session's pull request has moved on", async () => {
    // Both halves of the tuple matter: `remoteUrl` is rewritten in place when
    // `origin` changes, and pull-request numbers coincide across repositories.
    //
    // This is the one path where a merge ShipIt may have performed has nowhere
    // in the SESSION's state to go. That is not licence to drop it: the row is
    // the last copy of the evidence, so the question is asked of GitHub against
    // the claim's own repository and the answer goes in the transcript
    // (cross-agent review finding — the previous code wrote a `console.warn`,
    // which req 9 does not accept as a record).
    const claim = claimOne();
    sessions.recordPrProvenance(SESSION, 9, REPO_ID);
    const p = poller();
    const out = await settleAgentMerge(deps({ prStatusPoller: p }), claim, { witnessed: true });

    expect(out).toEqual({ result: "settled", merged: true });
    // Nothing promoted: no `merged_at`, no re-anchoring, no merge callbacks on a
    // session that has moved to a different pull request.
    expect(p.promoted).toEqual([]);
    const text = notices().join("\n");
    expect(text).toContain("#7 in acme/shipit");
    expect(text).toContain("its own state is unchanged");
    expect(claims.get(SESSION)).toBeNull();
  });

  it("records nothing for a moved-on session whose claimed commit did not merge", async () => {
    const claim = claimOne();
    sessions.recordPrProvenance(SESSION, 9, REPO_ID);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await settleAgentMerge(
      deps({ prStatusPoller: poller(facts({ merged_at: null, state: "open" })) }),
      claim, { witnessed: true },
    );
    expect(out).toEqual({ result: "not-merged" });
    expect(notices()).toEqual([]);
    expect(claims.get(SESSION)).toBeNull();
  });

  it("keeps the claim when GitHub cannot answer about a moved-on pull request", async () => {
    // The row is the only evidence left on this path, so an unanswered read must
    // not spend it.
    const claim = claimOne();
    sessions.recordPrProvenance(SESSION, 9, REPO_ID);
    const out = await settleAgentMerge(
      deps({ prStatusPoller: poller(null) }), claim, { witnessed: true },
    );
    expect(out).toMatchObject({ result: "deferred" });
    expect(claims.get(SESSION)).not.toBeNull();
  });

  // The three states the review found could be resolved wrongly.
  it("refuses to record a merge that landed at a DIFFERENT commit", async () => {
    // A pull request can be force-pushed and merged at another head between an
    // indeterminate attempt and this read. `merged_at` alone cannot tell that
    // apart from our own commit merging, and recording the claimed commit would
    // be a false record AND anchor the session's reset on the wrong commit.
    const claim = claimOne();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = poller(facts({ head_sha: "somebody-elses-commit" }));
    const out = await settleAgentMerge(deps({ prStatusPoller: p }), claim, { witnessed: false });

    expect(out).toEqual({ result: "not-merged" });
    expect(notices()).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("not the claimed commit");
    // And — the part the previous version of this test could not see — the
    // session was never promoted. The check used to run AFTER the promotion, so
    // `merged_at`, the reset anchor and the merge callbacks had all already
    // fired for the wrong commit by the time it decided to record nothing.
    expect(p.promoted).toEqual([]);
    expect(sessions.get(SESSION)?.mergedAt ?? null).toBeNull();
  });

  it("does not promote when a turn starts WHILE GitHub is answering", async () => {
    // The idle check the caller made is on the far side of an awaited round
    // trip. Reproduced rather than asserted: the fake starts a turn inside the
    // fetch, exactly where the real gap is (cross-agent review finding).
    const claim = claimOne();
    let turnRunning = false;
    const p = poller(facts(), { onFetch: () => { turnRunning = true; } });
    const out = await settleAgentMerge(deps({ prStatusPoller: p }), claim, {
      witnessed: false,
      stillSafeToSettle: () => !turnRunning,
    });

    expect(out).toMatchObject({ result: "deferred" });
    expect(p.promoteMergedPrByNumber).toHaveBeenCalled();
    expect(p.promoted).toEqual([]);
    expect(sessions.get(SESSION)?.mergedAt ?? null).toBeNull();
    // Nothing was written, so the row stays for the next pass.
    expect(claims.get(SESSION)).not.toBeNull();
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

  it("stands down when a DIFFERENT turn is running than the one that claimed", async () => {
    // The merge and the settlement are separated by a GitHub round trip. A turn
    // that ended in between no longer owns the session state this would write.
    const claim = claimOne();
    const p = poller();
    const runner = { running: true, turnEpoch: 4 };
    const reg = registry(runner);
    const turn = captureTurn(reg, SESSION);
    runner.turnEpoch = 5; // the claimed turn ended; its successor is running

    const out = await settleAgentMerge(
      deps({ prStatusPoller: p, runnerRegistry: reg }), claim, { witnessed: true, turn },
    );

    expect(out).toMatchObject({ result: "deferred" });
    expect(p.promoteMergedPrByNumber).not.toHaveBeenCalled();
  });

  it("stands down when the RUNNER was recreated under the same epoch", async () => {
    // `turnEpoch` restarts at 0 whenever a runner is recreated — a container
    // restart does that without restarting the orchestrator — so an epoch alone
    // reads a fresh runner's first turn as the turn that claimed the merge. The
    // token carries the runner, and a recreated runner is a different object.
    const claim = claimOne();
    const p = poller();
    const turn = captureTurn(registry({ running: true, turnEpoch: 0 }), SESSION);
    const afterRestart = registry({ running: true, turnEpoch: 0 });

    const out = await settleAgentMerge(
      deps({ prStatusPoller: p, runnerRegistry: afterRestart }), claim, { witnessed: true, turn },
    );

    expect(out).toMatchObject({ result: "deferred" });
    expect(p.promoteMergedPrByNumber).not.toHaveBeenCalled();
  });

  it("settles when the claiming turn is still the one running", async () => {
    const claim = claimOne();
    const p = poller();
    const reg = registry({ running: true, turnEpoch: 4 });
    const out = await settleAgentMerge(
      deps({ prStatusPoller: p, runnerRegistry: reg }),
      claim, { witnessed: true, turn: captureTurn(reg, SESSION) },
    );

    expect(out).toEqual({ result: "settled", merged: true });
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

  it("asks the CLAIM's repository, not the session's new one, after origin moved", async () => {
    const claim = claimOne();
    sessions.setRemoteUrl(SESSION, "https://github.com/acme/other.git");
    const p = poller();
    const out = await settleAgentMerge(deps({ prStatusPoller: p }), claim, { witnessed: true });
    expect(out).toEqual({ result: "settled", merged: true });
    // Addressed from `claim.repoId`. Reading the session's current remote here
    // would ask `acme/other` about a pull request that only exists in
    // `acme/shipit`, and answer about a different repository's #7.
    expect(p.readPrByNumber).toHaveBeenCalledWith("acme", "shipit", 7);
    expect(p.promoted).toEqual([]);
  });

  it("records once, not once per settlement attempt", async () => {
    const claim = claimOne();
    await settleAgentMerge(deps(), claim, { witnessed: true });
    // The claim is gone, so a repeat has nothing to settle — which is what makes
    // the record fire once rather than once per recovery.
    await settleAgentMerge(deps(), claim, { witnessed: true });
    expect(notices().filter((t) => t.includes("Merged pull request #7"))).toHaveLength(1);
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

describe("captureTurn", () => {
  it("answers null when nothing is running, so the merge route refuses", () => {
    expect(captureTurn(registry(null), SESSION)).toBeNull();
    expect(captureTurn(registry({ running: false, turnEpoch: 4 }), SESSION)).toBeNull();
  });

  it("carries the runner as well as the epoch", () => {
    const runner = { running: true, turnEpoch: 4 };
    expect(captureTurn(registry(runner), SESSION)).toEqual({ runner, epoch: 4 });
  });
});
