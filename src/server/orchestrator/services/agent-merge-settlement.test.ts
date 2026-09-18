import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AgentMergeClaimStore } from "../agent-merge-claims.js";
import { settleAgentMerge, reconcileAgentMergeClaims, captureTurn } from "./agent-merge-settlement.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { TerminalPrFacts } from "../github-auth-prs.js";

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

// Apply the guard after onFetch and record promotions to expose ordering errors.
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
    expect(p.promoteMergedPrByNumber).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, owner: "acme", repo: "shipit", prNumber: 7 }),
    );
    expect(claims.get(SESSION)).toBeNull();
    expect(notices().join("\n")).toContain("Merged pull request #7");
  });

  it("says only what it can prove when the merge was not witnessed", async () => {
    const claim = claimOne();
    await settleAgentMerge(deps(), claim, { witnessed: false });

    const text = notices().join("\n");
    expect(text).toContain("is now merged");
    expect(text).not.toContain("Merged pull request #7");
  });

  it("names the pull request and the commit in the record (req 9)", async () => {
    const claim = claimOne();
    await settleAgentMerge(deps(), claim, { witnessed: true });
    const text = notices().join("\n");
    expect(text).toContain("#7");
    expect(text).toContain("sha-head".slice(0, 8));
  });

  it("drops the claim without recording when the pull request is still open", async () => {
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
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("records the merge in the transcript when the session's pull request has moved on", async () => {
    const claim = claimOne();
    sessions.recordPrProvenance(SESSION, 9, REPO_ID);
    const p = poller();
    const out = await settleAgentMerge(deps({ prStatusPoller: p }), claim, { witnessed: true });

    expect(out).toEqual({ result: "settled", merged: true });
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
    const claim = claimOne();
    sessions.recordPrProvenance(SESSION, 9, REPO_ID);
    const out = await settleAgentMerge(
      deps({ prStatusPoller: poller(null) }), claim, { witnessed: true },
    );
    expect(out).toMatchObject({ result: "deferred" });
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("refuses to record a merge that landed at a DIFFERENT commit", async () => {
    const claim = claimOne();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = poller(facts({ head_sha: "somebody-elses-commit" }));
    const out = await settleAgentMerge(deps({ prStatusPoller: p }), claim, { witnessed: false });

    expect(out).toEqual({ result: "not-merged" });
    expect(notices()).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("not the claimed commit");
    expect(p.promoted).toEqual([]);
    expect(sessions.get(SESSION)?.mergedAt ?? null).toBeNull();
  });

  it("does not promote when a turn starts WHILE GitHub is answering", async () => {
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
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("still settles a WITNESSED merge whose head reads differently afterwards", async () => {
    const claim = claimOne();
    const out = await settleAgentMerge(
      deps({ prStatusPoller: poller(facts({ head_sha: null })) }),
      claim, { witnessed: true },
    );
    expect(out).toEqual({ result: "settled", merged: true });
  });

  it("never downgrades a `settling` claim to not-merged", async () => {
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
    const claim = claimOne();
    const p = poller();
    const runner = { running: true, turnEpoch: 4 };
    const reg = registry(runner);
    const turn = captureTurn(reg, SESSION);
    runner.turnEpoch = 5;

    const out = await settleAgentMerge(
      deps({ prStatusPoller: p, runnerRegistry: reg }), claim, { witnessed: true, turn },
    );

    expect(out).toMatchObject({ result: "deferred" });
    expect(p.promoteMergedPrByNumber).not.toHaveBeenCalled();
  });

  it("stands down when the RUNNER was recreated under the same epoch", async () => {
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
    expect(p.readPrByNumber).toHaveBeenCalledWith("acme", "shipit", 7);
    expect(p.promoted).toEqual([]);
  });

  it("records once, not once per settlement attempt", async () => {
    const claim = claimOne();
    await settleAgentMerge(deps(), claim, { witnessed: true });
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
    claimOne();
    const p = poller();
    await reconcileAgentMergeClaims(
      deps({ prStatusPoller: p, runnerRegistry: registry({ running: true, turnEpoch: 2 }) }),
    );
    expect(p.promoteMergedPrByNumber).not.toHaveBeenCalled();
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("stands down for post-turn work too, not only a running agent", async () => {
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


describe("settleAgentMerge — docs/288 requests", () => {
  function armOne(over: { expectedSha?: string; prNumber?: number } = {}) {
    claims.arm({
      sessionId: SESSION,
      repoId: REPO_ID,
      prNumber: over.prNumber ?? 7,
      expectedSha: over.expectedSha ?? "sha-head",
      method: "squash",
    });
    const claim = claims.get(SESSION)!;
    claims.beginMerging(claim);
    return { ...claim, state: "merging" as const };
  }

  it("tells the agent when a checked attempt turns out not to have merged", async () => {
    const claim = armOne();
    const out = await settleAgentMerge(
      deps({ prStatusPoller: poller(facts({ merged_at: null, state: "open" })) }),
      claim, { witnessed: false },
    );

    expect(out).toEqual({ result: "not-merged" });
    expect(notices().join(" ")).toContain("did not merge");
  });

  it("tells the agent when the pull request merged at a different commit", async () => {
    const claim = armOne();
    const out = await settleAgentMerge(
      deps({ prStatusPoller: poller(facts({ head_sha: "somebody-elses-sha" })) }),
      claim, { witnessed: false },
    );

    expect(out).toEqual({ result: "not-merged" });
    expect(notices().join(" ")).toContain("merged at a different commit");
  });

  it("does not delete a row that changed while GitHub was answering", async () => {
    const claim = armOne();
    const p = poller(facts({ merged_at: null, state: "open" }), {
      onFetch: () => {
        claims.release(SESSION, "sha-head");
        claims.arm({
          sessionId: SESSION, repoId: REPO_ID, prNumber: 9, expectedSha: "sha-head",
          method: "merge",
        });
        claims.beginMerging(claims.get(SESSION)!);
        claims.markMergeInFlight(SESSION);
      },
    });

    const out = await settleAgentMerge(deps({ prStatusPoller: p }), claim, { witnessed: false });

    expect(out).toMatchObject({ result: "deferred" });
    expect(claims.get(SESSION)).toMatchObject({ prNumber: 9, state: "merging" });
    claims.clearMergeInFlight(SESSION);
  });
});
