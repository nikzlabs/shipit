import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AgentMergeClaimStore } from "../agent-merge-claims.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOneRequest, runAgentMergeRequests, type AgentMergeExecutorDeps } from "./agent-merge-executor.js";
import { reconcileAgentMergeClaims, settleAgentMerge } from "./agent-merge-settlement.js";
import type { MergeObservation } from "./merge-gate.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { MergeAttempt } from "../github-auth-prs.js";
import type { TerminalPrFacts } from "../github-auth-prs.js";

/**
 * docs/288-agent-merge-arming — carrying out `gh pr merge --auto`.
 *
 * One rule is under test: wait only while the checks are running, merge when
 * they are green, end the request with a notice in every other case. The
 * asymmetry that shapes these: waiting costs a tick, merging the wrong commit
 * ships code nobody approved, and ending silently leaves an agent expecting a
 * merge that is never coming.
 */

const SESSION = "s1";
const REMOTE = "https://github.com/acme/shipit.git";
const REPO_ID = "github:acme/shipit";
const HEAD = "sha-head";

let dbManager: DatabaseManager;
let sessions: SessionManager;
let chatHistoryManager: ChatHistoryManager;
let claims: AgentMergeClaimStore;

function observation(over: Partial<Extract<MergeObservation, { kind: "read" }>> = {}): MergeObservation {
  return {
    kind: "read",
    prState: "OPEN",
    isDraft: false,
    reviewDecision: null,
    headRefOid: HEAD,
    rollupCommitOid: HEAD,
    rollupState: "SUCCESS",
    ...over,
  };
}

/**
 * A GitHub fake built from the SHAPE the gate reads, not from a canned
 * `MergeObservation`: `readMergeObservation` is what the executor calls, so a
 * fake that returned the parsed struct would skip the parser the production path
 * depends on and could not fail on a change to it.
 */
function github(opts: {
  read?: Extract<MergeObservation, { kind: "read" }> | null;
  attempt?: MergeAttempt;
  onMerge?: () => void;
} = {}) {
  const read = opts.read === undefined ? observation() : opts.read;
  const merges: { method: string; sha: string | undefined }[] = [];
  return {
    merges,
    graphqlQuery: vi.fn(async () => {
      if (read?.kind !== "read") return null;
      return {
        data: {
          repository: {
            pullRequest: {
              state: read.prState,
              isDraft: read.isDraft,
              reviewDecision: read.reviewDecision,
              headRefOid: read.headRefOid,
              commits: {
                nodes: [{
                  commit: {
                    oid: read.rollupCommitOid,
                    statusCheckRollup: read.rollupState === null ? null : { state: read.rollupState },
                  },
                }],
              },
            },
          },
        },
      };
    }),
    mergePullRequestAttempt: vi.fn(
      async (_o: string, _r: string, _n: number, method: string, sha?: string) => {
        opts.onMerge?.();
        merges.push({ method, sha });
        return opts.attempt ?? { outcome: "merged", message: "Merged" } as MergeAttempt;
      },
    ),
  } as unknown as GitHubAuthManager & { merges: { method: string; sha: string | undefined }[] };
}

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
    head_sha: HEAD,
    head_ref: "shipit/feature",
    additions: 1,
    deletions: 0,
    ...over,
  };
}

/** Settlement's poller, applying the guard where the real one does. */
function poller(opts: { grace?: boolean } = {}) {
  return {
    promoteMergedPrByNumber: vi.fn(async (args: { guard?: (pr: TerminalPrFacts) => boolean }) => {
      const pr = facts();
      if (args.guard && !args.guard(pr)) return { pr, promoted: false };
      return { pr, promoted: true };
    }),
    readPrByNumber: vi.fn(async () => facts()),
    awaitCiGraceDecision: vi.fn(async () => opts.grace === true),
  } as unknown as PrStatusPoller;
}

/** A runner that records the two things the exclusion is made of. */
function fakeRunner(over: Partial<{ running: boolean; agentBusy: boolean; queueLength: number }> = {}) {
  return {
    running: false,
    agentBusy: false,
    systemTurnInProgress: false,
    queueLength: 0,
    mergeHold: false,
    canRunDispatchedTurn: true,
    holdSeen: [] as boolean[],
    dequeue: () => null,
    emitMessage: () => {},
    dispatch: () => {},
    ...over,
  };
}

function registry(runner: object | null) {
  return { get: () => runner ?? undefined } as unknown as SessionRunnerRegistry;
}

function deps(over: Partial<AgentMergeExecutorDeps> = {}): AgentMergeExecutorDeps {
  return {
    claims,
    sessionManager: sessions,
    chatHistoryManager,
    repoStore: { allowsAgentMerge: () => true },
    githubAuthManager: over.githubAuthManager ?? github(),
    prStatusPoller: poller(),
    ...over,
  } as AgentMergeExecutorDeps;
}

function armed(over: { expectedSha?: string; method?: "merge" | "squash" | "rebase" } = {}) {
  claims.arm({
    sessionId: SESSION,
    repoId: REPO_ID,
    prNumber: 7,
    expectedSha: over.expectedSha ?? HEAD,
    method: over.method ?? "squash",
  });
  return claims.get(SESSION)!;
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

describe("runOneRequest — merging", () => {
  it("merges the armed commit, with the method the request recorded", async () => {
    const gh = github();
    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed({ method: "rebase" }));

    expect(out).toEqual({ result: "merged" });
    // req 2 — the commit is passed to GitHub, so a branch that moved between the
    // read and the call is refused by GitHub atomically rather than by us.
    expect(gh.merges).toEqual([{ method: "rebase", sha: HEAD }]);
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join(" ")).toContain("Merged pull request #7");
  });

  it("waits while the checks are running, and writes nothing", async () => {
    const gh = github({ read: { ...observation({ rollupState: "PENDING" }), kind: "read" } as never });
    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out).toMatchObject({ result: "waiting" });
    expect(gh.merges).toEqual([]);
    // The row survives — this is the state the whole feature waits in.
    expect(claims.get(SESSION)).toMatchObject({ state: "pending" });
    expect(notices()).toEqual([]);
  });

  it("waits out the zero-check grace, then merges when it expires", async () => {
    const none = { ...observation({ rollupState: null }) } as Extract<MergeObservation, { kind: "read" }>;
    const waiting = await runOneRequest(
      deps({ githubAuthManager: github({ read: none }), prStatusPoller: poller({ grace: true }) }),
      armed(),
    );
    expect(waiting).toMatchObject({ result: "waiting" });

    // Zero checks is either a repository with no CI or workflows that have not
    // registered. Only the grace expiring tells them apart.
    const gh = github({ read: none });
    const out = await runOneRequest(
      deps({ githubAuthManager: gh, prStatusPoller: poller({ grace: false }) }),
      armed(),
    );
    expect(out).toEqual({ result: "merged" });
    expect(gh.merges).toHaveLength(1);
  });

  it("waits, rather than acting, when GitHub cannot be read", async () => {
    // Assumed transient. Deleting the request on an unreadable answer would let
    // one rate-limited minute cancel work the agent expected to land.
    const gh = github({ read: null });
    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out).toMatchObject({ result: "waiting" });
    expect(claims.get(SESSION)).toMatchObject({ state: "pending" });
    expect(notices()).toEqual([]);
  });
});

describe("runOneRequest — ending the request", () => {
  it("cancels when the branch has moved past the armed commit (req 3)", async () => {
    const gh = github({ read: observation({ headRefOid: "sha-newer", rollupCommitOid: "sha-newer" }) as never });
    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out.result).toBe("ended");
    expect(gh.merges).toEqual([]);
    expect(claims.get(SESSION)).toBeNull();
    // req 3 — "and says so in the transcript". Silence here is the failure: the
    // agent asked for a merge and would otherwise never learn it is not coming.
    expect(notices().join(" ")).toContain("the branch has moved past");
  });

  it.each([
    ["a draft", observation({ isDraft: true }), "draft"],
    ["failing checks", observation({ rollupState: "FAILURE" }), "checks failed"],
    ["a required review", observation({ reviewDecision: "REVIEW_REQUIRED" }), "needs review"],
    ["a closed pull request", observation({ prState: "CLOSED" }), "closed"],
    ["a rollup ShipIt does not know", observation({ rollupState: "WEIRD" }), "does not read as passing"],
  ])("ends the request for %s, saying why", async (_name, read, expected) => {
    // Every one of these could in principle change later — a re-run, an
    // approval, a reopen — and waiting for that makes a request that never
    // terminates and an unbounded background job the user cannot see.
    const gh = github({ read: read as never });
    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out.result).toBe("ended");
    expect(gh.merges).toEqual([]);
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join(" ")).toContain(expected);
  });

  it("does not write session state when a turn starts during the recovery read", async () => {
    // The MERGED-by-somebody-else path runs OUTSIDE the hold, and settlement
    // promotes the pull request — which writes session state. A turn starting
    // while GitHub answers would have that landing under it.
    const runner = fakeRunner();
    const p = poller();
    (p.promoteMergedPrByNumber as unknown as { mockImplementation: (f: (a: { guard?: (pr: TerminalPrFacts) => boolean }) => Promise<unknown>) => void })
      .mockImplementation(async (args) => {
        runner.running = true;
        const pr = facts();
        if (args.guard && !args.guard(pr)) return { pr, promoted: false };
        return { pr, promoted: true };
      });

    const out = await runOneRequest(
      deps({
        githubAuthManager: github({ read: observation({ prState: "MERGED" }) as never }),
        prStatusPoller: p,
        runnerRegistry: registry(runner),
      }),
      armed(),
    );

    expect(out).toMatchObject({ result: "waiting" });
    // The row survives for the next pass rather than being resolved against a
    // promotion that was refused.
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("settles a pull request somebody else merged at the armed commit", async () => {
    // The user, or the pull-request card's own auto-merge. The request is
    // satisfied; what is left is docs/287's record, in its narrower wording.
    const gh = github({ read: observation({ prState: "MERGED" }) as never });
    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out).toEqual({ result: "merged" });
    expect(gh.merges).toEqual([]);
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join(" ")).toContain("is now merged");
  });

  it("does not retry an attempt whose outcome was never learned", async () => {
    // The one retry that could merge twice. The row stays `merging` so
    // reconciliation answers it from the tuple, and never returns to `pending`.
    const gh = github({ attempt: { outcome: "indeterminate", message: "socket hang up" } as MergeAttempt });
    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out.result).toBe("ended");
    expect(claims.get(SESSION)).toMatchObject({ state: "merging" });
    expect(notices().join(" ")).toContain("could not tell whether");
  });

  it("ends the request when GitHub refuses the merge, and says what it said", async () => {
    const gh = github({ attempt: { outcome: "refused", message: "Pull Request is not mergeable" } as MergeAttempt });
    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out.result).toBe("ended");
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join(" ")).toContain("Pull Request is not mergeable");
  });
});

describe("a request survives a restart (req 5)", () => {
  it("is carried out from the database alone, with no viewer and no runner", async () => {
    // The reason the request is a row and not a timer: the orchestrator can go
    // down between the agent asking and CI turning green, and nothing in memory
    // survives that. `listPending` is the whole recovery.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-merge-restart-"));
    const file = path.join(dir, "shipit.db");
    try {
      const first = new DatabaseManager(file);
      const firstSessions = new SessionManager(first);
      firstSessions.track(SESSION, "A session");
      firstSessions.setRemoteUrl(SESSION, REMOTE);
      firstSessions.recordPrProvenance(SESSION, 7, REPO_ID);
      new AgentMergeClaimStore(first).arm({
        sessionId: SESSION, repoId: REPO_ID, prNumber: 7, expectedSha: HEAD, method: "squash",
      });
      first.close();

      const second = new DatabaseManager(file);
      try {
        const store = new AgentMergeClaimStore(second);
        const gh = github();
        await runAgentMergeRequests({
          claims: store,
          sessionManager: new SessionManager(second),
          chatHistoryManager: new ChatHistoryManager(second),
          repoStore: { allowsAgentMerge: () => true },
          githubAuthManager: gh,
          prStatusPoller: poller(),
          // No runner registry at all: after a restart with no viewer there is
          // no container, and requiring one would make the common case the one
          // case this never fires in.
        });
        expect(gh.merges).toEqual([{ method: "squash", sha: HEAD }]);
        expect(store.get(SESSION)).toBeNull();
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runOneRequest — the permission (req 4)", () => {
  it("does not merge under a permission that was withdrawn after arming", async () => {
    // Revocation deletes pending rows; this covers the row that was mid-pass
    // while it did, and the restart that finds a row under a grant that is gone.
    const gh = github();
    const out = await runOneRequest(
      deps({ githubAuthManager: gh, repoStore: { allowsAgentMerge: () => false } }),
      armed(),
    );

    expect(out.result).toBe("ended");
    expect(gh.merges).toEqual([]);
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join(" ")).toContain("was withdrawn");
  });
});

describe("runOneRequest — a merge and a turn are mutually exclusive (req 6)", () => {
  it.each([
    ["a running turn", { running: true }],
    ["an agent still busy", { agentBusy: true }],
    ["a system flow holding the session", { systemTurnInProgress: true }],
    ["a queued message", { queueLength: 1 }],
  ])("does not merge while the session has %s", async (_name, state) => {
    const gh = github();
    const runner = fakeRunner(state as never);
    const out = await runOneRequest(
      deps({ githubAuthManager: gh, runnerRegistry: registry(runner) }),
      armed(),
    );

    expect(out).toMatchObject({ result: "waiting" });
    expect(gh.merges).toEqual([]);
    expect(claims.get(SESSION)).toMatchObject({ state: "pending" });
    // And asks GitHub nothing. The later check under the hold would also stop
    // the merge, so without this assertion the busy session still costs a
    // GraphQL read on every tick for as long as the turn runs.
    expect(gh.graphqlQuery).not.toHaveBeenCalled();
  });

  it("holds the session for the whole call and releases the queue after it", async () => {
    // The hold is what a turn started mid-merge would collide with: it would push
    // behind a merge already in flight. `releaseQueuedTurn` is the other half —
    // draining is event-driven, and a background merge has no owning turn whose
    // completion would drain the queue afterwards.
    const runner = fakeRunner();
    let heldDuringCall = false;
    const gh = github({ onMerge: () => { heldDuringCall = runner.mergeHold; } });
    const dispatched: unknown[] = [];
    runner.queueLength = 0;
    runner.dispatch = ((o: unknown) => { dispatched.push(o); }) as typeof runner.dispatch;

    const out = await runOneRequest(
      deps({ githubAuthManager: gh, runnerRegistry: registry(runner) }),
      armed(),
    );

    expect(out).toEqual({ result: "merged" });
    expect(heldDuringCall).toBe(true);
    // Cleared afterwards, or the session can never start another turn.
    expect(runner.mergeHold).toBe(false);
  });

  it("releases the hold when the merge throws", async () => {
    // A hold left set by a throw is a session that accepts messages and runs
    // none of them, with nothing that would ever clear it.
    const runner = fakeRunner();
    const gh = github();
    (gh.mergePullRequestAttempt as unknown as { mockImplementation: (f: () => never) => void })
      .mockImplementation(() => { throw new Error("boom"); });

    await expect(runOneRequest(
      deps({ githubAuthManager: gh, runnerRegistry: registry(runner) }),
      armed(),
    )).rejects.toThrow("boom");
    expect(runner.mergeHold).toBe(false);
  });

  it("stands down when a turn starts while GitHub is answering the read", async () => {
    // The window the second idle check exists for. The first one passed.
    const runner = fakeRunner();
    const gh = github();
    (gh.graphqlQuery as unknown as { mockImplementation: (f: () => Promise<unknown>) => void })
      .mockImplementation(async () => {
        runner.running = true;
        return {
          data: {
            repository: {
              pullRequest: {
                state: "OPEN", isDraft: false, reviewDecision: null, headRefOid: HEAD,
                commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: "SUCCESS" } } }] },
              },
            },
          },
        };
      });

    const out = await runOneRequest(
      deps({ githubAuthManager: gh, runnerRegistry: registry(runner) }),
      armed(),
    );

    expect(out).toMatchObject({ result: "waiting" });
    expect(gh.merges).toEqual([]);
    expect(claims.get(SESSION)).toMatchObject({ state: "pending" });
    expect(runner.mergeHold).toBe(false);
  });

  it("is invisible to reconciliation, which would delete it as not merged", async () => {
    // Settlement resolves an ATTEMPT: it asks "did this merge?" and deletes the
    // row when the answer is no. A request has not been attempted, so the end of
    // every turn would destroy it.
    armed();
    await reconcileAgentMergeClaims(
      { claims, sessionManager: sessions, chatHistoryManager, prStatusPoller: poller() },
      { sessionId: SESSION },
    );
    expect(claims.get(SESSION)).toMatchObject({ state: "pending" });

    // And directly, for any other caller: settlement refuses it rather than
    // relying on reconciliation having filtered it out first.
    const out = await settleAgentMerge(
      { claims, sessionManager: sessions, chatHistoryManager, prStatusPoller: poller() },
      claims.get(SESSION)!,
      { witnessed: false },
    );
    expect(out).toMatchObject({ result: "deferred" });
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("treats a session with no runner as idle", async () => {
    // A session whose container is gone is not mid-turn, and requiring one would
    // make the common case — the turn ended, the container went idle — the one
    // case the feature never fires in.
    const gh = github();
    const out = await runOneRequest(
      deps({ githubAuthManager: gh, runnerRegistry: registry(null) }),
      armed(),
    );

    expect(out).toEqual({ result: "merged" });
    expect(gh.merges).toHaveLength(1);
  });
});
