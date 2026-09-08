/**
 * docs/295 — the decision's gates. What happens on `yes` is a `/compact` turn
 * and a queued message, covered end to end by
 * `integration_tests/pre-turn-compaction.test.ts`. The eligibility predicate
 * itself belongs to `services/pre-turn-reset.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionInfo } from "../shared/types.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { GitManager } from "../shared/git.js";
import type { SessionRunnerInterface } from "./session-runner.js";

const supportsCompaction = vi.fn<() => boolean>(() => true);
vi.mock("../shared/agent-registry.js", () => ({
  getAgentCapabilities: () => ({ supportsCompaction: supportsCompaction() }),
}));

const { shouldCompactBeforeTurn } = await import("./compact-before-turn.js");

const MERGED_SHA = "a1f3c9d0000000000000000000000000000000aa";
const BASE_TIP = "7e02b480000000000000000000000000000000bb";

beforeEach(() => {
  supportsCompaction.mockReset();
  supportsCompaction.mockReturnValue(true);
});

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Fix login redirect",
    createdAt: "2026-06-01T00:00:00.000Z",
    lastUsedAt: "2026-06-01T00:00:00.000Z",
    remoteUrl: "https://github.com/o/r.git",
    branch: "shipit/fix-login",
    mergedAt: "2026-06-02 12:00:00",
    mergedHeadSha: MERGED_SHA,
    ...over,
  } as SessionInfo;
}

function makePrStatus(over: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 482,
    prUrl: "https://github.com/o/r/pull/482",
    prState: "merged",
    baseBranch: "main",
    headBranch: "shipit/fix-login",
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    ...over,
  } as unknown as PrStatusSummary;
}

/** An eligible tree: merged, clean, HEAD still exactly at the merged commit. */
function makeGit(over: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
  return {
    isClean: vi.fn().mockResolvedValue(true),
    currentBranchOrNull: vi.fn().mockResolvedValue("shipit/fix-login"),
    isRebaseInProgress: vi.fn().mockResolvedValue(false),
    isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(false),
    getHeadHash: vi.fn().mockResolvedValue(MERGED_SHA),
    getRefHash: vi.fn().mockResolvedValue(BASE_TIP),
    isAncestor: vi.fn().mockResolvedValue(false),
    ...over,
  } as unknown as GitManager;
}

function ask(over: {
  session?: SessionInfo | undefined;
  git?: GitManager;
  setting?: boolean;
  intent?: boolean;
  resident?: boolean;
  backgroundWork?: string[];
  conversationReplay?: string;
  /** Build the `"unsettled"` race through the REAL `recheckMergeBeforeTurn`. */
  unsettled?: boolean;
} = {}): Promise<boolean> {
  const unsettled = over.unsettled === true;
  const sessionRef = {
    value: "session" in over
      ? over.session
      : unsettled
        ? makeSession({ mergedAt: undefined })
        : makeSession(),
  };
  const runner = {
    getAgent: () => (over.resident ? {} : null),
    backgroundWorkDescriptions: over.backgroundWork ?? [],
  } as unknown as SessionRunnerInterface;

  return shouldCompactBeforeTurn({
    deps: {
      getSession: () => sessionRef.value,
      getSessionRow: () => (over.conversationReplay
        ? { ...sessionRef.value, conversationReplay: over.conversationReplay } as SessionInfo
        : sessionRef.value),
      getPrStatus: () => (unsettled ? makePrStatus({ prState: "open" }) : makePrStatus()),
      createGitManager: () => over.git ?? (unsettled
        // `origin/<branch>` at HEAD, so the probe's "has the branch moved?"
        // clause passes and it reaches the network step under test.
        ? makeGit({
            getRefHash: vi.fn((ref: string) =>
              Promise.resolve(ref === "origin/shipit/fix-login" ? MERGED_SHA : BASE_TIP)),
          })
        : makeGit()),
      getAutoResetMergedBranch: () => over.setting ?? true,
      mergeRecheckDeps: {
        verifyPrState: () => {
          // The probe found the merge and stamped `merged_at`…
          if (unsettled) sessionRef.value = makeSession();
          return Promise.resolve();
        },
        // …and the rest of the bookkeeping is still in flight when the budget
        // expires.
        awaitMergeHandling: () => (unsettled
          ? new Promise<void>(() => { /* never settles */ })
          : Promise.resolve()),
      },
    } as unknown as Parameters<typeof shouldCompactBeforeTurn>[0]["deps"],
    runner,
    agentId: "claude",
    sessionId: "s1",
    sessionDir: "/w/s1",
    ...(over.intent !== undefined ? { intent: over.intent } : {}),
  });
}

describe("shouldCompactBeforeTurn", () => {
  it("says yes for a merged, eligible session", async () => {
    expect(await ask()).toBe(true);
  });

  it("says yes with no per-send intent at all — the programmatic path (req 13)", async () => {
    // No tick box exists on a dispatch, so the global setting alone decides.
    expect(await ask({ intent: undefined })).toBe(true);
  });

  it("says no when the user unticked the control for this message (req 5)", async () => {
    expect(await ask({ intent: false })).toBe(false);
  });

  it("says no when the shared setting is off (req 11)", async () => {
    expect(await ask({ setting: false, intent: true })).toBe(false);
  });

  it("says no when the backend cannot compact (req 10)", async () => {
    supportsCompaction.mockReturnValue(false);
    expect(await ask()).toBe(false);
  });

  it("says no on a session that is not merged (reqs 1 and 3)", async () => {
    expect(await ask({ session: makeSession({ mergedAt: undefined }) })).toBe(false);
  });

  it("says no when the branch has moved past the merge, so a reset would be refused", async () => {
    expect(await ask({
      git: makeGit({ getHeadHash: vi.fn().mockResolvedValue("cafe0000000000000000000000000000000000ff") }),
    })).toBe(false);
  });

  it("says no rather than displacing a resident that holds background work", async () => {
    expect(await ask({ resident: true, backgroundWork: ["reviewing the diff"] })).toBe(false);
  });

  it("says no when a conversation replay is armed", async () => {
    expect(await ask({ conversationReplay: "…the transcript so far…" })).toBe(false);
  });

  it("says no when the merge recheck is unsettled, exactly as the reset does", async () => {
    vi.useFakeTimers();
    try {
      const pending = ask({ unsettled: true });
      await vi.advanceTimersByTimeAsync(8_001);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says no rather than throwing when the eligibility check blows up", async () => {
    expect(await ask({
      git: makeGit({ isClean: vi.fn().mockRejectedValue(new Error("git exploded")) }),
    })).toBe(false);
  });
});
