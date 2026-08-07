/**
 * docs/211 — the sandbox invariant at the post-turn commit boundary.
 *
 * `postTurnCommit` runs `git.autoCommit()` on the session dir unconditionally
 * today, which would error on a sandbox's non-repo root. So a `kind ===
 * "sandbox"` session must skip the whole session-level git flow (commit + push
 * + the PR card it gates) — explicitly by kind, NOT inferred from `remoteUrl`.
 */

import { describe, it, expect, vi } from "vitest";
import { postTurnCommit } from "./post-turn.js";
import type { SessionInfo } from "../../shared/types.js";

function makeCtx(kind?: SessionInfo["kind"]) {
  const autoCommit = vi.fn(async () => ({ commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [] }));
  const getHeadHash = vi.fn(async () => null);
  const scheduleAutoPush = vi.fn();
  const createGitManager = vi.fn(() => ({ autoCommit, getHeadHash }));
  const ctx = {
    createGitManager,
    chatHistoryManager: { updateLastMessage: vi.fn(), indexOfMessageId: vi.fn() },
    sessionManager: {
      get: vi.fn(() => (kind ? ({ id: "s1", kind } as SessionInfo) : undefined)),
      getSecretBlock: vi.fn(() => undefined),
      setSecretBlock: vi.fn(),
    },
    scheduleAutoPush,
  } as unknown as Parameters<typeof postTurnCommit>[0];
  return { ctx, autoCommit, scheduleAutoPush, createGitManager };
}

describe("postTurnCommit — sandbox invariant", () => {
  it("skips auto-commit/push entirely for a kind=sandbox session", async () => {
    const { ctx, autoCommit, scheduleAutoPush, createGitManager } = makeCtx("sandbox");
    const result = await postTurnCommit(ctx, {
      sessionDir: "/workspace",
      sessionId: "s1",
      emit: vi.fn(),
      turnSummary: "did stuff",
    });
    expect(result).toBeNull();
    // The gate returns BEFORE constructing a GitManager — the unconditional
    // autoCommit (which would error on the non-repo root) never runs, and no
    // push is scheduled (so no PR card downstream).
    expect(createGitManager).not.toHaveBeenCalled();
    expect(autoCommit).not.toHaveBeenCalled();
    expect(scheduleAutoPush).not.toHaveBeenCalled();
  });

  it("runs the normal commit flow for an ordinary (non-sandbox) session", async () => {
    const { ctx, autoCommit } = makeCtx(undefined);
    await postTurnCommit(ctx, {
      sessionDir: "/workspace",
      sessionId: "s1",
      emit: vi.fn(),
      turnSummary: "did stuff",
    });
    // No kind → the gate doesn't fire and autoCommit is attempted as usual.
    expect(autoCommit).toHaveBeenCalledTimes(1);
  });

  it("still commits for an ops session — only sandbox skips the commit", async () => {
    const { ctx, autoCommit } = makeCtx("ops");
    await postTurnCommit(ctx, {
      sessionDir: "/workspace",
      sessionId: "s1",
      emit: vi.fn(),
      turnSummary: "did stuff",
    });
    expect(autoCommit).toHaveBeenCalledTimes(1);
  });
});

/**
 * docs/128 — an ops session commits but never auto-pushes. Its workspace is a
 * throwaway cockpit with no remote and no branch lifecycle; a `gh pr list --repo`
 * that wired an `origin` into it once got its template commits pushed at the real
 * ShipIt repo (rejected only because the histories were unrelated).
 */
describe("postTurnCommit — ops sessions never auto-push", () => {
  function makeCommittingCtx(kind?: SessionInfo["kind"]) {
    const autoCommit = vi.fn(async () => ({
      commitHash: "abc1234", conflictedFiles: [], rebaseInProgress: false, secretFindings: [],
    }));
    const getHeadHash = vi.fn(async () => "oldhead");
    const scheduleAutoPush = vi.fn();
    const createGitManager = vi.fn(() => ({ autoCommit, getHeadHash }));
    const ctx = {
      createGitManager,
      chatHistoryManager: { updateLastMessage: vi.fn(() => null), indexOfMessageId: vi.fn(() => -1) },
      sessionManager: {
      get: vi.fn(() => (kind ? ({ id: "s1", kind } as SessionInfo) : undefined)),
      getSecretBlock: vi.fn(() => undefined),
      setSecretBlock: vi.fn(),
    },
      scheduleAutoPush,
    } as unknown as Parameters<typeof postTurnCommit>[0];
    return { ctx, autoCommit, scheduleAutoPush };
  }

  it("commits an ops session's turn but schedules no push", async () => {
    const emit = vi.fn();
    const { ctx, autoCommit, scheduleAutoPush } = makeCommittingCtx("ops");
    const hash = await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit, turnSummary: "investigated",
    });
    expect(hash).toBe("abc1234");
    expect(autoCommit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "git_committed" }));
    expect(scheduleAutoPush).not.toHaveBeenCalled();
  });

  it("pushes an ordinary session's turn as before", async () => {
    const { ctx, scheduleAutoPush } = makeCommittingCtx(undefined);
    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "did stuff",
    });
    expect(scheduleAutoPush).toHaveBeenCalledTimes(1);
  });

  it("skips the moved-HEAD push for an ops session too", async () => {
    // The agent ran its own `git commit`, so autoCommit finds a clean tree and
    // the push is armed off the HEAD move instead. Same gate applies.
    const autoCommit = vi.fn(async () => ({
      commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [],
    }));
    const scheduleAutoPush = vi.fn();
    const ctx = {
      createGitManager: vi.fn(() => ({
        autoCommit,
        getHeadHash: vi.fn(async () => "newhead"),
        isAncestor: vi.fn(async () => true),
        diffRange: vi.fn(async () => "diff --git a/ok.ts b/ok.ts\n+const x = 1;"),
      })),
      chatHistoryManager: { updateLastMessage: vi.fn(), indexOfMessageId: vi.fn(), append: vi.fn() },
      sessionManager: {
        get: vi.fn(() => ({ id: "s1", kind: "ops" } as SessionInfo)),
        getSecretBlock: vi.fn(() => undefined),
        setSecretBlock: vi.fn(),
      },
      scheduleAutoPush,
    } as unknown as Parameters<typeof postTurnCommit>[0];

    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "x", turnStartHeadHash: "oldhead",
    });
    expect(scheduleAutoPush).not.toHaveBeenCalled();
  });
});

/**
 * docs/213 — when the agent moves HEAD itself this turn (its own `git commit`),
 * autoCommit makes no new commit but post-turn auto-pushes the moved HEAD. Guard
 * that push: scan the added commits, refuse on a secret — but only when HEAD is a
 * pure addition (turnStartHead is an ancestor), to avoid false-blocking a rebase.
 */
describe("postTurnCommit — agent self-commit (moved HEAD) secret guard", () => {
  // Built at runtime so this (non-allowlisted) test file carries no literal token.
  const FAKE_PAT = `ghp_${"A".repeat(36)}`;
  const secretDiff = [
    "diff --git a/leak.ts b/leak.ts",
    "--- /dev/null",
    "+++ b/leak.ts",
    "@@ -0,0 +1 @@",
    `+const t = "${FAKE_PAT}";`,
  ].join("\n");
  const cleanDiff = "diff --git a/ok.ts b/ok.ts\n--- /dev/null\n+++ b/ok.ts\n@@ -0,0 +1 @@\n+const x = 1;";

  function makeMovedHeadCtx(opts: { isAncestor: boolean; diff: string }) {
    const autoCommit = vi.fn(async () => ({ commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [] }));
    const getHeadHash = vi.fn(async () => "newhead");
    const isAncestor = vi.fn(async () => opts.isAncestor);
    const diffRange = vi.fn(async () => opts.diff);
    const scheduleAutoPush = vi.fn();
    const append = vi.fn();
    const createGitManager = vi.fn(() => ({ autoCommit, getHeadHash, isAncestor, diffRange }));
    const ctx = {
      createGitManager,
      chatHistoryManager: { updateLastMessage: vi.fn(), indexOfMessageId: vi.fn(), append },
      sessionManager: {
        get: vi.fn(() => undefined),
        getSecretBlock: vi.fn(() => undefined),
        setSecretBlock: vi.fn(),
      },
      scheduleAutoPush,
    } as unknown as Parameters<typeof postTurnCommit>[0];
    return { ctx, scheduleAutoPush, append, isAncestor, diffRange };
  }

  it("refuses to push an agent-added commit that introduces a secret", async () => {
    const emit = vi.fn();
    const { ctx, scheduleAutoPush, append } = makeMovedHeadCtx({ isAncestor: true, diff: secretDiff });
    const result = await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit, turnSummary: "x", turnStartHeadHash: "oldhead",
    });
    expect(result).toBeNull();
    expect(scheduleAutoPush).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalled(); // persisted warning notice
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "system_notice", level: "warn" }));
  });

  it("still pushes a clean agent-added commit", async () => {
    const { ctx, scheduleAutoPush } = makeMovedHeadCtx({ isAncestor: true, diff: cleanDiff });
    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "x", turnStartHeadHash: "oldhead",
    });
    expect(scheduleAutoPush).toHaveBeenCalledTimes(1);
  });

  it("skips the content scan on rewritten history (rebase) so it can't false-block", async () => {
    const { ctx, scheduleAutoPush, diffRange } = makeMovedHeadCtx({ isAncestor: false, diff: secretDiff });
    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "x", turnStartHeadHash: "oldhead",
    });
    expect(diffRange).not.toHaveBeenCalled();
    expect(scheduleAutoPush).toHaveBeenCalledTimes(1);
  });
});

/**
 * planning#297 — a merged session's post-turn auto-push RECREATES the branch GitHub
 * deleted at merge, stranding the commit as an orphan that belongs to no pull
 * request. The commit still happens (work is never lost); only the silent push is
 * refused, and the refusal always leaves a persisted notice — the silence is what
 * made the user report this twice as "changes are missing from the merged PR".
 */
describe("postTurnCommit — merged sessions never silently auto-push", () => {
  const MERGED_SHA = "025e9609";

  function makeMergedCtx(opts: {
    session?: Partial<SessionInfo>;
    prStatus?: unknown;
    commitHash?: string | null;
    /** Is the merged tip still an ancestor of HEAD (i.e. not rebased away)? */
    stackedOnMergedTip?: boolean;
  }) {
    const autoCommit = vi.fn(async () => ({
      commitHash: opts.commitHash === undefined ? "0d9a31d1" : opts.commitHash,
      conflictedFiles: [], rebaseInProgress: false, secretFindings: [],
    }));
    const scheduleAutoPush = vi.fn();
    const append = vi.fn();
    const emit = vi.fn();
    const ctx = {
      createGitManager: vi.fn(() => ({
        autoCommit,
        getHeadHash: vi.fn(async () => "0d9a31d1"),
        isAncestor: vi.fn(async () => opts.stackedOnMergedTip ?? true),
        diffRange: vi.fn(async () => "diff --git a/ok.ts b/ok.ts\n+const x = 1;"),
      })),
      chatHistoryManager: { updateLastMessage: vi.fn(() => null), indexOfMessageId: vi.fn(() => -1), append },
      sessionManager: {
        get: vi.fn(() => ({
          id: "s1", branch: "shipit/codex-poll",
          mergedAt: "2026-08-04 16:33:40", mergedHeadSha: MERGED_SHA,
          ...opts.session,
        } as SessionInfo)),
        getPrStatus: vi.fn(() => opts.prStatus ?? { prNumber: 1963, baseBranch: "main" }),
        getSecretBlock: vi.fn(() => undefined),
        setSecretBlock: vi.fn(),
      },
      scheduleAutoPush,
    } as unknown as Parameters<typeof postTurnCommit>[0];
    return { ctx, scheduleAutoPush, append, emit };
  }

  it("commits but refuses the push, and persists a notice naming the merged PR", async () => {
    const { ctx, scheduleAutoPush, append, emit } = makeMergedCtx({});
    const hash = await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit, turnSummary: "Added, in both places",
    });
    // The work is committed — the guard never costs the user their edits.
    expect(hash).toBe("0d9a31d1");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "git_committed" }));
    // …but it does not silently land on a branch whose PR already merged.
    expect(scheduleAutoPush).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalled(); // persisted, so it survives a reload
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "system_notice", level: "warn", message: expect.stringContaining("#1963") }),
    );
  });

  it("still refuses the push when the agent moved HEAD itself (no auto-commit)", async () => {
    const { ctx, scheduleAutoPush, append } = makeMergedCtx({ commitHash: null });
    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "x", turnStartHeadHash: "oldhead",
    });
    expect(scheduleAutoPush).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalled();
  });

  it("pushes normally once the branch has been rebased off the merged tip", async () => {
    // The prescribed keep-shipping flow: rebase onto the fresh base, commit, open
    // a new PR. `mergedAt` is still set (docs/202 re-arms AFTER this), so without
    // the ancestry test this legitimate push would be blocked and mis-explained.
    const { ctx, scheduleAutoPush, append } = makeMergedCtx({ stackedOnMergedTip: false });
    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "next slice",
    });
    expect(scheduleAutoPush).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
  });

  it("pushes normally for a session that is not merged", async () => {
    const { ctx, scheduleAutoPush, append } = makeMergedCtx({ session: { mergedAt: undefined } });
    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "ordinary turn",
    });
    expect(scheduleAutoPush).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
  });

  it("does not let a failing notice write take the turn down", async () => {
    const { ctx, scheduleAutoPush } = makeMergedCtx({});
    (ctx.chatHistoryManager as unknown as { append: () => void }).append = () => {
      throw new Error("database is locked");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const hash = await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "x",
    });
    // The commit — and the caller's PR flow, which is gated on this hash — survive.
    expect(hash).toBe("0d9a31d1");
    expect(scheduleAutoPush).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

/**
 * planning#317 — the refusal has to reach BOTH actors from the real post-turn path,
 * not just the transcript. These pin the wiring; `services/secret-block.test.ts`
 * pins the state machine itself.
 */
describe("postTurnCommit — a secret-blocked commit is sticky and announced", () => {
  const FINDING = {
    rule: "github-pat",
    description: "GitHub personal access token",
    file: "src/config.ts",
    line: 11,
    redacted: "ghp_…[redacted, 40 chars]",
  };

  function makeSecretCtx(opts: { findings?: unknown[]; commitHash?: string | null } = {}) {
    const setSecretBlock = vi.fn();
    let stored: unknown;
    const autoCommit = vi.fn(async () => ({
      commitHash: opts.commitHash ?? null,
      conflictedFiles: [],
      rebaseInProgress: false,
      secretFindings: opts.findings ?? [FINDING],
    }));
    const append = vi.fn();
    const emit = vi.fn();
    const dispatch = vi.fn();
    const ctx = {
      createGitManager: vi.fn(() => ({
        autoCommit,
        getHeadHash: vi.fn(async () => null),
      })),
      chatHistoryManager: { updateLastMessage: vi.fn(() => null), indexOfMessageId: vi.fn(() => -1), append },
      sessionManager: {
        get: vi.fn(() => ({ id: "s1" } as SessionInfo)),
        getSecretBlock: vi.fn(() => stored),
        setSecretBlock: vi.fn((_id: string, b: unknown) => {
          stored = b ?? undefined;
          setSecretBlock(_id, b);
        }),
      },
      scheduleAutoPush: vi.fn(),
    } as unknown as Parameters<typeof postTurnCommit>[0];
    return { ctx, emit, append, dispatch, setSecretBlock };
  }

  it("persists the block, broadcasts the banner, and dispatches a remediation turn", async () => {
    const { ctx, emit, append, dispatch, setSecretBlock } = makeSecretCtx();
    const hash = await postTurnCommit(ctx, {
      sessionDir: "/workspace",
      sessionId: "s1",
      emit,
      turnSummary: "pasted a token",
      runner: { dispatch, running: false } as never,
    });

    expect(hash).toBeNull();
    // 1. Sticky state — survives the runner and a reload.
    expect(setSecretBlock).toHaveBeenCalledWith("s1", expect.objectContaining({ notifyCount: 1 }));
    // 2. The banner.
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "secret_block_status", sessionId: "s1" }),
    );
    // 3. The transcript row (unchanged behavior).
    expect(append).toHaveBeenCalled();
    // 4. The agent is told its work did not land — the part that was missing.
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("clears the block once a commit lands", async () => {
    const { ctx, emit } = makeSecretCtx({ findings: [], commitHash: "abc1234" });
    // Pre-arm a standing block so the clear has something to retire.
    ctx.sessionManager.setSecretBlock("s1", { findings: [FINDING], at: "x", notifyCount: 2 } as never);
    emit.mockClear();

    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit, turnSummary: "scrubbed it",
    });

    expect(emit).toHaveBeenCalledWith({ type: "secret_block_status", sessionId: "s1", block: null });
  });

  it("does NOT clear the block on a conflict refusal — that path never scanned", async () => {
    // `autoCommit` returns before staging when the tree is conflicted, so a
    // secret may still be sitting there unscanned. Clearing here would retire
    // the banner on a lie.
    const setSecretBlock = vi.fn();
    const ctx = {
      createGitManager: vi.fn(() => ({
        autoCommit: vi.fn(async () => ({
          commitHash: null, conflictedFiles: ["a.ts"], rebaseInProgress: false, secretFindings: [],
        })),
        getHeadHash: vi.fn(async () => null),
      })),
      chatHistoryManager: { updateLastMessage: vi.fn(() => null), indexOfMessageId: vi.fn(() => -1), append: vi.fn() },
      sessionManager: {
        get: vi.fn(() => ({ id: "s1" } as SessionInfo)),
        getSecretBlock: vi.fn(() => ({ findings: [FINDING], at: "x", notifyCount: 2 })),
        setSecretBlock,
      },
      scheduleAutoPush: vi.fn(),
    } as unknown as Parameters<typeof postTurnCommit>[0];

    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "conflicted",
    });

    expect(setSecretBlock).not.toHaveBeenCalled();
  });
});
