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
import { SessionRunner, type SessionRunnerRegistry } from "../session-runner.js";
import { unprobedAfterRestart } from "../restart-turn-reattach.js";
import type { MergeAttempt } from "../github-auth-prs.js";
import type { TerminalPrFacts } from "../github-auth-prs.js";

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
      async (
        _o: string, _r: string, _n: number, method: string, sha?: string,
        beforeSend?: () => string | null,
      ) => {
        // Simulate the wrapper's GET before its final permission check and PUT.
        opts.onMerge?.();
        const refusal = beforeSend?.();
        if (refusal) return { outcome: "refused", message: refusal } as MergeAttempt;
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

function fakeRunner(over: Partial<{ running: boolean; agentBusy: boolean; queueLength: number }> = {}) {
  const busy = over.agentBusy ?? false;
  const runner = {
    running: false,
    // Match production: a lease makes the runner busy.
    get agentBusy(): boolean { return busy || runner.leaseDepth > 0; },
    systemTurnInProgress: false,
    queueLength: 0,
    mergeHold: false,
    canRunDispatchedTurn: true,
    leaseDepth: 0,
    dispatched: [] as unknown[],
    dequeue: () => {
      runner.queueLength -= 1;
      return { text: "queued while merging", execution: "dispatched" as const };
    },
    getQueueSnapshot: () => [],
    emitted: [] as { type?: string; message?: string }[],
    emitMessage: (m: unknown) => { runner.emitted.push(m as { type?: string; message?: string }); },
    dispatch: (o: unknown) => { runner.dispatched.push(o); },
    beginPostTurnWork: () => { runner.leaseDepth += 1; },
    endPostTurnWork: () => { runner.leaseDepth -= 1; },
    // Preserve the agentBusy getter.
    ...(({ agentBusy: _drop, ...rest }) => rest)({ agentBusy: false, ...over }),
  };
  return runner;
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
    expect(gh.merges).toEqual([{ method: "rebase", sha: HEAD }]);
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join(" ")).toContain("Merged pull request #7");
  });

  it("waits while the checks are running, and writes nothing", async () => {
    const gh = github({ read: { ...observation({ rollupState: "PENDING" }), kind: "read" } as never });
    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out).toMatchObject({ result: "waiting" });
    expect(gh.merges).toEqual([]);
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

    const gh = github({ read: none });
    const out = await runOneRequest(
      deps({ githubAuthManager: gh, prStatusPoller: poller({ grace: false }) }),
      armed(),
    );
    expect(out).toEqual({ result: "merged" });
    expect(gh.merges).toHaveLength(1);
  });

  it("waits, rather than acting, when GitHub cannot be read", async () => {
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
    expect(notices().join(" ")).toContain("the branch has moved past");
  });

  it("shows the cancellation to whoever is watching, not only to history", async () => {
    const runner = fakeRunner();
    const gh = github({ read: observation({ headRefOid: "sha-newer", rollupCommitOid: "sha-newer" }) as never });
    await runOneRequest(
      deps({ githubAuthManager: gh, runnerRegistry: registry(runner) }),
      armed(),
    );

    const notice = runner.emitted.find((m) => m.type === "system_notice");
    expect(notice?.message).toContain("the branch has moved past");
    expect(notices()).toHaveLength(1);
  });

  it.each([
    ["a draft", observation({ isDraft: true }), "draft"],
    ["failing checks", observation({ rollupState: "FAILURE" }), "checks failed"],
    ["a required review", observation({ reviewDecision: "REVIEW_REQUIRED" }), "needs review"],
    ["a closed pull request", observation({ prState: "CLOSED" }), "closed"],
    ["a rollup ShipIt does not know", observation({ rollupState: "WEIRD" }), "does not read as passing"],
  ])("ends the request for %s, saying why", async (_name, read, expected) => {
    const gh = github({ read: read as never });
    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out.result).toBe("ended");
    expect(gh.merges).toEqual([]);
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join(" ")).toContain(expected);
  });

  it("does not write session state when a turn starts during the recovery read", async () => {
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
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("settles a pull request somebody else merged at the armed commit", async () => {
    const gh = github({ read: observation({ prState: "MERGED" }) as never });
    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out).toEqual({ result: "merged" });
    expect(gh.merges).toEqual([]);
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join(" ")).toContain("is now merged");
  });

  it("does not retry an attempt whose outcome was never learned", async () => {
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

describe("an attempt that can never resolve says so", () => {
  it("reports a stuck attempt once, and keeps the row", async () => {
    armed();
    claims.beginMerging(claims.get(SESSION)!);
    const dead = {
      promoteMergedPrByNumber: vi.fn(async () => null),
      readPrByNumber: vi.fn(async () => null),
      awaitCiGraceDecision: vi.fn(async () => false),
    } as unknown as PrStatusPoller;

    const d = deps({ prStatusPoller: dead });
    for (let i = 0; i < 20; i++) await runAgentMergeRequests(d);

    const said = notices().filter((t) => t.includes("still cannot tell"));
    expect(said).toHaveLength(1);
    expect(claims.get(SESSION)).toMatchObject({ state: "merging" });
  });
});

describe("a request survives a restart (req 5)", () => {
  it("is carried out from the database alone, with no viewer and no runner", async () => {
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

describe("runOneRequest — the checks must be this commit's (req 1)", () => {
  it("waits when the rollup still describes an earlier commit, however green it is", async () => {
    const gh = github({
      read: observation({ rollupCommitOid: "sha-older", rollupState: "SUCCESS" }) as never,
    });
    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out).toMatchObject({ result: "waiting" });
    expect(gh.merges).toEqual([]);
    expect(claims.get(SESSION)).toMatchObject({ state: "pending" });
  });
});

describe("runOneRequest — the request names its own repository (req 2)", () => {
  it("does not merge the armed repository under a repointed session's grant", async () => {
    const gh = github();
    armed();
    sessions.setRemoteUrl(SESSION, "https://github.com/acme/other.git");

    const out = await runOneRequest(deps({ githubAuthManager: gh }), claims.get(SESSION)!);

    expect(out.result).toBe("ended");
    expect(gh.merges).toEqual([]);
    expect(gh.graphqlQuery).not.toHaveBeenCalled();
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join(" ")).toContain("no longer the pull request ShipIt opened");
  });
});

describe("runOneRequest — an unreadable pull request cannot wait for ever (req 1)", () => {
  it("ends the request after a long run of unreadable answers, and says so", async () => {
    const claim = armed();
    const gh = github({ read: null });
    let last = await runOneRequest(deps({ githubAuthManager: gh }), claim);
    for (let i = 0; i < 20 && last.result === "waiting"; i++) {
      last = await runOneRequest(deps({ githubAuthManager: gh }), claim);
    }
    expect(last.result).toBe("ended");
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join(" ")).toContain("could not read it");
  });

  it("counts CONSECUTIVE failures — one good answer clears the run", async () => {
    const claim = armed();
    for (let i = 0; i < 20; i++) {
      await runOneRequest(deps({ githubAuthManager: github({ read: null }) }), claim);
      await runOneRequest(
        deps({ githubAuthManager: github({ read: observation({ rollupState: "PENDING" }) as never }) }),
        claim,
      );
    }
    expect(claims.get(SESSION)).toMatchObject({ state: "pending" });
  });
});

describe("runOneRequest — the permission (req 4)", () => {
  it("does not merge a request the user cancelled mid-flight, even if re-granted", async () => {
    const gh = github({
      onMerge: () => {
        claims.cancelPendingForRepo(REPO_ID);
      },
    });

    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out.result).toBe("ended");
    expect(gh.merges).toEqual([]);
    expect(notices().join(" ")).toContain("was withdrawn");
  });


  it("re-reads the grant in the instant before the merge call", async () => {
    let granted = true;
    const gh = github({ read: observation() as never });
    (gh.graphqlQuery as unknown as { mockImplementation: (f: () => Promise<unknown>) => void })
      .mockImplementation(async () => {
        granted = false;
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
      deps({ githubAuthManager: gh, repoStore: { allowsAgentMerge: () => granted } }),
      armed(),
    );

    expect(out.result).toBe("ended");
    expect(gh.merges).toEqual([]);
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join(" ")).toContain("was withdrawn");
  });

  it("does not send the merge when the grant goes during the wrapper's own read", async () => {
    let granted = true;
    const gh = github({ onMerge: () => { granted = false; } });

    const out = await runOneRequest(
      deps({ githubAuthManager: gh, repoStore: { allowsAgentMerge: () => granted } }),
      armed(),
    );

    expect(out.result).toBe("ended");
    expect(gh.mergePullRequestAttempt).toHaveBeenCalled();
    expect(gh.merges).toEqual([]);
  });

  it("does not merge under a permission that was withdrawn after arming", async () => {
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
    expect(gh.graphqlQuery).not.toHaveBeenCalled();
  });

  it("holds the session for the whole call and STARTS the message that waited", async () => {
    const runner = fakeRunner();
    let heldDuringCall = false;
    let leasedDuringCall = 0;
    const gh = github({
      onMerge: () => {
        heldDuringCall = runner.mergeHold;
        leasedDuringCall = runner.leaseDepth;
        runner.queueLength = 1;
      },
    });

    const out = await runOneRequest(
      deps({ githubAuthManager: gh, runnerRegistry: registry(runner) }),
      armed(),
    );

    expect(out).toEqual({ result: "merged" });
    expect(heldDuringCall).toBe(true);
    expect(leasedDuringCall).toBe(1);
    expect(runner.mergeHold).toBe(false);
    expect(runner.leaseDepth).toBe(0);
    expect(runner.dispatched).toHaveLength(1);
    expect(runner.queueLength).toBe(0);
  });

  it("releases the hold when something after the merge throws", async () => {
    const runner = fakeRunner();
    const p = poller();
    (p.promoteMergedPrByNumber as unknown as { mockImplementation: (f: () => never) => void })
      .mockImplementation(() => { throw new Error("boom"); });

    await expect(runOneRequest(
      deps({ prStatusPoller: p, runnerRegistry: registry(runner) }),
      armed(),
    )).rejects.toThrow("boom");
    expect(runner.mergeHold).toBe(false);
    expect(claims.isMergeInFlight(SESSION)).toBe(false);
  });

  it("keeps the in-flight mark up for the whole call, and releases a runner born under it", async () => {
    // Factory tests cover inheriting the hold; this test covers releasing it.
    let created: ReturnType<typeof fakeRunner> | null = null;
    let markedDuringCall = false;
    const gh = github({
      onMerge: () => {
        markedDuringCall = claims.isMergeInFlight(SESSION);
        created = fakeRunner();
        created.mergeHold = true;
      },
    });

    const out = await runOneRequest(
      deps({
        githubAuthManager: gh,
        runnerRegistry: { get: () => created ?? undefined } as unknown as SessionRunnerRegistry,
      }),
      armed(),
    );

    expect(out).toEqual({ result: "merged" });
    expect(markedDuringCall).toBe(true);
    expect(created!.mergeHold).toBe(false);
    expect(claims.isMergeInFlight(SESSION)).toBe(false);
  });

  it("treats a throw from the merge call as indeterminate, not as a failure", async () => {
    const gh = github();
    (gh.mergePullRequestAttempt as unknown as { mockImplementation: (f: () => never) => void })
      .mockImplementation(() => { throw new Error("socket hang up"); });

    const out = await runOneRequest(deps({ githubAuthManager: gh }), armed());

    expect(out.result).toBe("ended");
    expect(claims.get(SESSION)).toMatchObject({ state: "merging" });
    expect(notices().join(" ")).toContain("could not tell whether");
  });

  it("stands down when a turn starts while GitHub is answering the read", async () => {
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

  it("is not resolved by reconciliation while its REST call is in flight", async () => {
    armed();
    const reconciled: string[] = [];
    const gh = github({
      onMerge: async () => {
        await reconcileAgentMergeClaims(
          {
            claims,
            sessionManager: sessions,
            chatHistoryManager,
            prStatusPoller: poller(),
          },
          { sessionId: SESSION },
        );
        reconciled.push(claims.get(SESSION)?.state ?? "gone");
      },
    });

    const out = await runOneRequest(deps({ githubAuthManager: gh }), claims.get(SESSION)!);

    expect(reconciled).toEqual(["merging"]);
    expect(out).toEqual({ result: "merged" });
    expect(notices().join(" ")).toContain("Merged pull request #7");
  });

  it("is invisible to reconciliation, which would delete it as not merged", async () => {
    armed();
    await reconcileAgentMergeClaims(
      { claims, sessionManager: sessions, chatHistoryManager, prStatusPoller: poller() },
      { sessionId: SESSION },
    );
    expect(claims.get(SESSION)).toMatchObject({ state: "pending" });

    const out = await settleAgentMerge(
      { claims, sessionManager: sessions, chatHistoryManager, prStatusPoller: poller() },
      claims.get(SESSION)!,
      { witnessed: false },
    );
    expect(out).toMatchObject({ result: "deferred" });
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("merges on a REAL runner, not only on the fake", async () => {
    const real = new SessionRunner({
      sessionId: SESSION, sessionDir: "/tmp/s1", defaultAgentId: "claude" as never,
    });
    try {
      const gh = github();
      const out = await runOneRequest(
        deps({ githubAuthManager: gh, runnerRegistry: registry(real) }),
        armed(),
      );

      expect(out).toEqual({ result: "merged" });
      expect(gh.merges).toHaveLength(1);
      expect(real.mergeHold).toBe(false);
      expect(real.postTurnWorkInFlight).toBe(false);
      expect(real.agentBusy).toBe(false);
    } finally {
      real.dispose({ force: true });
    }
  });

  it("still refuses on a REAL runner that is genuinely busy", async () => {
    const real = new SessionRunner({
      sessionId: SESSION, sessionDir: "/tmp/s1", defaultAgentId: "claude" as never,
    });
    try {
      real.running = true;
      const gh = github();
      const out = await runOneRequest(
        deps({ githubAuthManager: gh, runnerRegistry: registry(real) }),
        armed(),
      );

      expect(out).toMatchObject({ result: "waiting" });
      expect(gh.merges).toEqual([]);
    } finally {
      real.running = false;
      real.dispose({ force: true });
    }
  });

  it("does not merge a session whose startup probe never established it", async () => {
    unprobedAfterRestart.add(SESSION);
    try {
      const gh = github();
      const out = await runOneRequest(
        deps({ githubAuthManager: gh, runnerRegistry: registry(null) }),
        armed(),
      );

      expect(out).toMatchObject({ result: "waiting" });
      expect(gh.merges).toEqual([]);
      expect(claims.get(SESSION)).toMatchObject({ state: "pending" });
    } finally {
      unprobedAfterRestart.delete(SESSION);
    }
  });

  it("merges once a runner exists, whatever the startup probe did", async () => {
    unprobedAfterRestart.add(SESSION);
    const real = new SessionRunner({
      sessionId: SESSION, sessionDir: "/tmp/s1", defaultAgentId: "claude" as never,
    });
    try {
      const gh = github();
      const out = await runOneRequest(
        deps({ githubAuthManager: gh, runnerRegistry: registry(real) }),
        armed(),
      );
      expect(out).toEqual({ result: "merged" });
      expect(unprobedAfterRestart.has(SESSION)).toBe(false);
    } finally {
      unprobedAfterRestart.delete(SESSION);
      real.dispose({ force: true });
    }
  });

  it("treats a session with no runner as idle", async () => {
    const gh = github();
    const out = await runOneRequest(
      deps({ githubAuthManager: gh, runnerRegistry: registry(null) }),
      armed(),
    );

    expect(out).toEqual({ result: "merged" });
    expect(gh.merges).toHaveLength(1);
  });
});
