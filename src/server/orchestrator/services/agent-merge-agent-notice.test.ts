import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AgentMergeClaimStore } from "../agent-merge-claims.js";
import { SessionInboxStore } from "../session-inbox-store.js";
import { prepareInboxNotice } from "./session-inbox-notice.js";
import { runOneRequest, type AgentMergeExecutorDeps } from "./agent-merge-executor.js";
import { settleAgentMerge } from "./agent-merge-settlement.js";
import type { MergeObservation } from "./merge-gate.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { MergeAttempt, TerminalPrFacts } from "../github-auth-prs.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { SessionRunnerRegistry } from "../session-runner.js";

const SESSION = "s1";
const REMOTE = "https://github.com/acme/shipit.git";
const REPO_ID = "github:acme/shipit";
const HEAD = "sha-head";
const REBASED = "sha-rebased";

let dbManager: DatabaseManager;
let sessions: SessionManager;
let chatHistoryManager: ChatHistoryManager;
let claims: AgentMergeClaimStore;
let inboxStore: SessionInboxStore;
let tell: ReturnType<typeof vi.fn>;

type Read = Extract<MergeObservation, { kind: "read" }>;

function observation(over: Partial<Read> = {}): Read {
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

function github(read: Read | null, attempt?: MergeAttempt) {
  const merges: (string | undefined)[] = [];
  return {
    merges,
    graphqlQuery: vi.fn(async () => (read === null ? null : {
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
    })),
    mergePullRequestAttempt: vi.fn(async (
      _o: string, _r: string, _n: number, _m: string, sha?: string, beforeSend?: () => string | null,
    ) => {
      const refusal = beforeSend?.();
      if (refusal) return { outcome: "refused", message: refusal } as MergeAttempt;
      merges.push(sha);
      return attempt ?? ({ outcome: "merged", message: "Merged" } as MergeAttempt);
    }),
  } as unknown as GitHubAuthManager & { merges: (string | undefined)[] };
}

function facts(over: Partial<TerminalPrFacts> = {}): TerminalPrFacts {
  return {
    url: "https://github.com/acme/shipit/pull/7", number: 7, base: "main", title: "A pull request", body: "",
    state: "closed", merged_at: "2026-11-13T12:00:00Z", merge_commit_sha: "merge-sha", head_sha: HEAD,
    head_ref: "shipit/feature", additions: 1, deletions: 0, ...over,
  };
}

function poller(pr: TerminalPrFacts = facts()) {
  return {
    promoteMergedPrByNumber: vi.fn(async () => ({ pr, promoted: true })),
    readPrByNumber: vi.fn(async () => pr),
    awaitCiGraceDecision: vi.fn(async () => false),
    awaitMergeHandling: vi.fn(async () => {}),
  } as unknown as PrStatusPoller;
}

function deps(over: Partial<AgentMergeExecutorDeps> = {}): AgentMergeExecutorDeps {
  return {
    claims,
    sessionManager: sessions,
    chatHistoryManager,
    repoStore: { allowsAgentMerge: () => true },
    githubAuthManager: github(observation()),
    prStatusPoller: poller(),
    ...over,
  };
}

function arm(expectedSha = HEAD) {
  claims.arm({ sessionId: SESSION, repoId: REPO_ID, prNumber: 7, expectedSha, method: "squash" });
  return claims.get(SESSION)!;
}

function agentMessages(): string[] {
  return inboxStore.unread(SESSION).map((m) => m.body);
}

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  sessions = new SessionManager(dbManager);
  chatHistoryManager = new ChatHistoryManager(dbManager);
  claims = new AgentMergeClaimStore(dbManager);
  inboxStore = new SessionInboxStore(sessions.database);
  tell = vi.fn(async () => "started");
  claims.setAgentInbox({
    add: (id, message, alongside) => { inboxStore.add(id, message, alongside); },
    tell: tell as unknown as (id: string) => Promise<"started">,
  });
  sessions.track(SESSION, "A session");
  sessions.setRemoteUrl(SESSION, REMOTE);
  sessions.recordPrProvenance(SESSION, 7, REPO_ID);
});

afterEach(() => {
  dbManager.close();
});

describe("every request that ends without a merge reaches the agent (docs/343-agent-merge-cancel-notice req 1, 2)", () => {
  it.each([
    ["a push ShipIt did not make", observation({ headRefOid: "sha-other", rollupCommitOid: "sha-other" }), "the branch has moved past"],
    ["a closed pull request", observation({ prState: "CLOSED" }), "closed"],
    ["a draft", observation({ isDraft: true }), "draft"],
    ["failed checks", observation({ rollupState: "FAILURE" }), "checks failed"],
    ["a required review", observation({ reviewDecision: "REVIEW_REQUIRED" }), "needs review"],
    ["an unknown rollup state", observation({ rollupState: "WEIRD" as never }), "does not read as passing"],
  ])("%s", async (_name, read, reason) => {
    const out = await runOneRequest(deps({ githubAuthManager: github(read) }), arm());

    expect(out.result).toBe("ended");
    expect(agentMessages()).toHaveLength(1);
    expect(agentMessages()[0]).toContain("[ShipIt]");
    expect(agentMessages()[0]).toContain("pull request #7");
    expect(agentMessages()[0]).toContain(reason);
    // The user's notice is unchanged.
    expect(chatHistoryManager.load(SESSION).map((m) => m.text).join(" ")).toContain(reason);
    // Telling is what starts an idle session or steers a running turn.
    expect(tell).toHaveBeenCalledWith(SESSION);
  });

  it("a repointed pull request", async () => {
    const claim = arm();
    sessions.recordPrProvenance(SESSION, 8, REPO_ID);
    await runOneRequest(deps(), claim);
    expect(agentMessages()[0]).toContain("no longer the pull request ShipIt opened");
  });

  it("withdrawn permission", async () => {
    await runOneRequest(deps({ repoStore: { allowsAgentMerge: () => false } }), arm());
    expect(agentMessages()[0]).toContain("was withdrawn");
  });

  it("a pull request ShipIt cannot read, after the run of failures", async () => {
    const claim = arm();
    const d = deps({ githubAuthManager: github(null) });
    for (let i = 0; i < 14; i++) await runOneRequest(d, claim);
    expect(agentMessages()).toEqual([]);
    await runOneRequest(d, claim);
    expect(agentMessages()[0]).toContain("could not read it");
  });

  it("permission withdrawn in the instant before the merge call", async () => {
    let granted = true;
    const gh = github(observation());
    (gh.mergePullRequestAttempt as unknown as { mockImplementationOnce: (f: unknown) => void })
      .mockImplementationOnce(async (_o: string, _r: string, _n: number, _m: string, _s: string, before: () => string | null) => {
        granted = false;
        return { outcome: "refused", message: before() ?? "refused" };
      });
    await runOneRequest(deps({ githubAuthManager: gh, repoStore: { allowsAgentMerge: () => granted } }), arm());
    expect(gh.merges).toEqual([]);
    expect(agentMessages()[0]).toContain("was withdrawn");
  });

  it("GitHub refusing the merge", async () => {
    const gh = github(observation(), { outcome: "refused", message: "Pull Request is not mergeable" });
    await runOneRequest(deps({ githubAuthManager: gh }), arm());
    expect(agentMessages()[0]).toContain("Pull Request is not mergeable");
  });

  it("an attempt that settlement finds did not merge", async () => {
    arm();
    claims.beginMerging(claims.get(SESSION)!);
    const outcome = await settleAgentMerge(
      { claims, sessionManager: sessions, chatHistoryManager, prStatusPoller: poller(facts({ merged_at: null })) },
      claims.get(SESSION)!,
      { witnessed: false },
    );
    expect(outcome.result).toBe("not-merged");
    expect(agentMessages()[0]).toContain("did not merge at");
  });

  it("not for a merge that happened", async () => {
    const out = await runOneRequest(deps(), arm());
    expect(out).toEqual({ result: "merged" });
    expect(agentMessages()).toEqual([]);
    expect(tell).not.toHaveBeenCalled();
  });
});

describe("the agent is told once (docs/343-agent-merge-cancel-notice req 5)", () => {
  it("a second pass over the same request stores nothing more", async () => {
    const claim = arm();
    const d = deps({ githubAuthManager: github(observation({ isDraft: true })) });
    await runOneRequest(d, claim);
    const again = await runOneRequest(d, claim);

    expect(again.result).toBe("waiting");
    expect(agentMessages()).toHaveLength(1);
  });

  it("rides the next prompt until the agent reads it, and not after", async () => {
    await runOneRequest(deps({ githubAuthManager: github(observation({ isDraft: true })) }), arm());

    expect(prepareInboxNotice(inboxStore, SESSION)?.notice).toContain("1 unread message");
    inboxStore.takeUnread(SESSION);
    expect(prepareInboxNotice(inboxStore, SESSION)).toBeNull();
  });

  it("a branch-sync notice does not replace it", async () => {
    await runOneRequest(deps({ githubAuthManager: github(observation({ isDraft: true })) }), arm());
    sessions.setPendingAgentNotice(SESSION, "[System] While you were idle, this branch was rebased.");

    expect(agentMessages()).toHaveLength(1);
    expect(sessions.consumePendingAgentNotice(SESSION)).toContain("rebased");
  });

  it("a store that fails leaves the request pending, to end on a later pass", async () => {
    claims.setAgentInbox({ add: () => { throw new Error("disk full"); }, tell: tell as never });
    const claim = arm();
    await expect(runOneRequest(deps({ githubAuthManager: github(observation({ isDraft: true })) }), claim))
      .rejects.toThrow("disk full");
    expect(claims.get(SESSION)).toMatchObject({ state: "pending" });
    expect(chatHistoryManager.load(SESSION)).toEqual([]);
  });
});

describe("a failed inbox write never loses the ending (docs/343-agent-merge-cancel-notice req 1)", () => {
  function failingInbox(): void {
    claims.setAgentInbox({ add: () => { throw new Error("disk full"); }, tell: tell as never });
  }

  it("a refused merge keeps its attempt row, which reconciliation settles and reports", async () => {
    failingInbox();
    const gh = github(observation(), { outcome: "refused", message: "Pull Request is not mergeable" });
    await expect(runOneRequest(deps({ githubAuthManager: gh }), arm())).rejects.toThrow("disk full");
    expect(claims.get(SESSION)).toMatchObject({ state: "merging" });
  });

  it("settlement keeps the row, and writes no transcript notice either", async () => {
    arm();
    claims.beginMerging(claims.get(SESSION)!);
    failingInbox();
    await expect(settleAgentMerge(
      { claims, sessionManager: sessions, chatHistoryManager, prStatusPoller: poller(facts({ merged_at: null })) },
      claims.get(SESSION)!,
      { witnessed: false },
    )).rejects.toThrow("disk full");
    expect(claims.get(SESSION)).not.toBeNull();
    expect(chatHistoryManager.load(SESSION)).toEqual([]);
  });
});

describe("a request ShipIt moved to its rebased commit (docs/343-agent-merge-cancel-notice req 3)", () => {
  it("merges the rebased commit once its checks pass", async () => {
    arm(HEAD);
    claims.retarget(SESSION, HEAD, REBASED);

    const pending = await runOneRequest(
      deps({ githubAuthManager: github(observation({ headRefOid: REBASED, rollupCommitOid: REBASED, rollupState: "PENDING" })) }),
      claims.get(SESSION)!,
    );
    expect(pending.result).toBe("waiting");

    const gh = github(observation({ headRefOid: REBASED, rollupCommitOid: REBASED }));
    const out = await runOneRequest(
      deps({ githubAuthManager: gh, prStatusPoller: poller(facts({ head_sha: REBASED })) }),
      claims.get(SESSION)!,
    );
    expect(out).toEqual({ result: "merged" });
    expect(gh.merges).toEqual([REBASED]);
    expect(agentMessages()).toEqual([]);
  });

  it("only moves a pending request armed at the commit ShipIt rebased", () => {
    arm(HEAD);
    expect(claims.retarget(SESSION, "sha-other", REBASED)).toBeNull();
    expect(claims.get(SESSION)?.expectedSha).toBe(HEAD);

    claims.beginMerging(claims.get(SESSION)!);
    expect(claims.retarget(SESSION, HEAD, REBASED)).toBeNull();
    expect(claims.get(SESSION)?.expectedSha).toBe(HEAD);
  });

  it("waits, rather than cancelling, when the branch moved while ShipIt held the session", async () => {
    const claim = arm(HEAD);
    const runner = { running: false, sessionHold: null as object | null, agentBusy: false, queueLength: 0, mergeHold: false };
    const registry = { get: () => runner } as unknown as SessionRunnerRegistry;
    const gh = github(observation({ headRefOid: REBASED, rollupCommitOid: REBASED }));
    const read = gh.graphqlQuery.bind(gh);
    // The rebase takes the session while the executor's read is in flight.
    gh.graphqlQuery = (async (...args: Parameters<typeof read>) => {
      runner.sessionHold = {};
      return read(...args);
    }) as typeof read;

    const out = await runOneRequest(deps({ githubAuthManager: gh, runnerRegistry: registry }), claim);

    expect(out.result).toBe("waiting");
    expect(claims.get(SESSION)).toMatchObject({ state: "pending", expectedSha: HEAD });
    expect(agentMessages()).toEqual([]);
  });
});
