import { describe, it, expect, vi } from "vitest";
import { postTurnCommit } from "./post-turn.js";
import { chownWorkspaceGitToSessionWorker } from "../session-worker-uid.js";
import type { SessionInfo } from "../../shared/types.js";

// Mock ownership changes: /workspace is the actual checkout.
vi.mock("../session-worker-uid.js", () => ({
  chownWorkspaceGitToSessionWorker: vi.fn(),
}));

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

describe("postTurnCommit — auto-commit gate", () => {
  for (const kind of ["sandbox", "ops"] as const) {
    it(`skips auto-commit/push entirely for a kind=${kind} session`, async () => {
      const { ctx, autoCommit, scheduleAutoPush, createGitManager } = makeCtx(kind);
      const result = await postTurnCommit(ctx, {
        sessionDir: "/workspace",
        sessionId: "s1",
        emit: vi.fn(),
        turnSummary: "did stuff",
      });
      expect(result).toBeNull();
      expect(createGitManager).not.toHaveBeenCalled();
      expect(autoCommit).not.toHaveBeenCalled();
      expect(scheduleAutoPush).not.toHaveBeenCalled();
    });
  }

  it("runs the normal commit flow for an ordinary session", async () => {
    const { ctx, autoCommit } = makeCtx(undefined);
    await postTurnCommit(ctx, {
      sessionDir: "/workspace",
      sessionId: "s1",
      emit: vi.fn(),
      turnSummary: "did stuff",
    });
    expect(autoCommit).toHaveBeenCalledTimes(1);
  });
});

describe("postTurnCommit — gate does not widen, and covers the moved-HEAD push", () => {
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

  it("makes no commit and emits no git_committed for an ops session", async () => {
    const emit = vi.fn();
    const { ctx, autoCommit, scheduleAutoPush } = makeCommittingCtx("ops");
    const hash = await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit, turnSummary: "investigated",
    });
    expect(hash).toBeNull();
    expect(autoCommit).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "git_committed" }));
    expect(scheduleAutoPush).not.toHaveBeenCalled();
  });

  it("commits and pushes an ordinary session's turn as before", async () => {
    const { ctx, scheduleAutoPush, autoCommit } = makeCommittingCtx(undefined);
    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "did stuff",
    });
    expect(autoCommit).toHaveBeenCalledTimes(1);
    expect(scheduleAutoPush).toHaveBeenCalledTimes(1);
  });

  describe("deferPushArm", () => {
    it("hands the arm over instead of firing it, and the arm pushes exactly what the inline one would", async () => {
      const { ctx, scheduleAutoPush } = makeCommittingCtx(undefined);
      let handed: (() => void) | null = null;

      await postTurnCommit(ctx, {
        sessionDir: "/workspace",
        sessionId: "s1",
        emit: vi.fn(),
        turnSummary: "did stuff",
        deferPushArm: (arm) => { handed = arm; },
      });

      expect(scheduleAutoPush).not.toHaveBeenCalled();
      expect(handed).toBeTypeOf("function");

      handed!();
      expect(scheduleAutoPush).toHaveBeenCalledTimes(1);
      expect(scheduleAutoPush).toHaveBeenCalledWith(expect.anything(), "s1");
    });

    it("hands over nothing when the merged-branch guard refuses the push", async () => {
      const { ctx, scheduleAutoPush } = makeCommittingCtx(undefined);
      const sm = (ctx as unknown as {
        sessionManager: { get: ReturnType<typeof vi.fn>; getPrStatus?: ReturnType<typeof vi.fn> };
      }).sessionManager;
      sm.get = vi.fn(() => ({ id: "s1", mergedAt: new Date().toISOString() } as unknown as SessionInfo));
      sm.getPrStatus = vi.fn(() => null);
      let handed: (() => void) | null = null;

      await postTurnCommit(ctx, {
        sessionDir: "/workspace",
        sessionId: "s1",
        emit: vi.fn(),
        turnSummary: "did stuff",
        deferPushArm: (arm) => { handed = arm; },
      });

      expect(handed).toBeNull();
      expect(scheduleAutoPush).not.toHaveBeenCalled();
    });
  });

  it("skips the moved-HEAD push for an ops session too", async () => {
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
    expect(autoCommit).not.toHaveBeenCalled();
    expect(scheduleAutoPush).not.toHaveBeenCalled();
  });
});

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
    expect(append).toHaveBeenCalled();
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

describe("postTurnCommit — merged sessions never silently auto-push", () => {
  const MERGED_SHA = "025e9609";

  function makeMergedCtx(opts: {
    session?: Partial<SessionInfo>;
    prStatus?: unknown;
    commitHash?: string | null;
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
    expect(hash).toBe("0d9a31d1");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "git_committed" }));
    expect(scheduleAutoPush).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalled();
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
    expect(hash).toBe("0d9a31d1");
    expect(scheduleAutoPush).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

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
    expect(setSecretBlock).toHaveBeenCalledWith("s1", expect.objectContaining({ notifyCount: 1 }));
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "secret_block_status", sessionId: "s1" }),
    );
    expect(append).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("clears the block once a commit lands", async () => {
    const { ctx, emit } = makeSecretCtx({ findings: [], commitHash: "abc1234" });
    ctx.sessionManager.setSecretBlock("s1", { findings: [FINDING], at: "x", notifyCount: 2 } as never);
    emit.mockClear();

    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit, turnSummary: "scrubbed it",
    });

    expect(emit).toHaveBeenCalledWith({ type: "secret_block_status", sessionId: "s1", block: null });
  });

  it("does NOT clear the block on a conflict refusal — that path never scanned", async () => {
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

describe("postTurnCommit — unreadable workspace content", () => {
  function makeCtx(unreadable: { kind: "omitted" | "blocked"; detail: string } | null, commitHash: string | null) {
    const autoCommit = vi.fn(async () => ({
      commitHash, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable,
    }));
    const getHeadHash = vi.fn(async () => "head");
    const setSecretBlock = vi.fn();
    const ctx = {
      createGitManager: vi.fn(() => ({ autoCommit, getHeadHash })),
      chatHistoryManager: { updateLastMessage: vi.fn(() => null), indexOfMessageId: vi.fn(() => -1), append: vi.fn() },
      sessionManager: {
        get: vi.fn(() => ({ id: "s1" } as SessionInfo)),
        getSecretBlock: vi.fn(() => ({ findings: [], at: 1 })),
        setSecretBlock,
      },
      scheduleAutoPush: vi.fn(),
    } as unknown as Parameters<typeof postTurnCommit>[0];
    return { ctx, setSecretBlock };
  }

  it("tells the user a commit is SHORT when a directory was unreadable", async () => {
    const emit = vi.fn();
    const { ctx } = makeCtx({ kind: "omitted", detail: "pgdata/" }, "abc1234");
    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit, turnSummary: "a turn",
    });
    const notices = emit.mock.calls.map(([m]) => JSON.stringify(m)).join("\n");
    expect(notices).toContain("pgdata/");
    expect(notices).toContain("short");
  });

  it("does not call a commit short when the turn produced no commit at all", async () => {
    const emit = vi.fn();
    const { ctx } = makeCtx({ kind: "omitted", detail: "pgdata/" }, null);
    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit, turnSummary: "a turn",
    });
    const notices = emit.mock.calls.map(([m]) => JSON.stringify(m)).join("\n");
    expect(notices).toContain("pgdata/");
    expect(notices).toContain("NO commit");
    expect(notices).not.toContain("everything else was committed normally");
  });

  it("tells the user NOTHING was committed when a file was unreadable", async () => {
    const emit = vi.fn();
    const { ctx } = makeCtx({ kind: "blocked", detail: "d/server.key" }, null);
    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit, turnSummary: "a turn",
    });
    const notices = emit.mock.calls.map(([m]) => JSON.stringify(m)).join("\n");
    expect(notices).toContain("server.key");
    expect(notices).toContain("NOT committed");
  });

  it("does not retire a standing secret block when nothing was staged", async () => {
    const { ctx, setSecretBlock } = makeCtx({ kind: "blocked", detail: "d/server.key" }, null);
    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "a turn",
    });
    expect(setSecretBlock).not.toHaveBeenCalledWith("s1", null);
  });

  it("still retires the block on an `omitted` commit, which DID stage and scan", async () => {
    const { ctx, setSecretBlock } = makeCtx({ kind: "omitted", detail: "pgdata/" }, "abc1234");
    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "a turn",
    });
    expect(setSecretBlock).toHaveBeenCalledWith("s1", null);
  });
});

describe("postTurnCommit — an auto-commit that threw", () => {
  function makeThrowingCtx(err: Error) {
    const append = vi.fn();
    const ctx = {
      createGitManager: vi.fn(() => ({
        autoCommit: vi.fn(() => Promise.reject(err)),
        getHeadHash: vi.fn(async () => "head"),
      })),
      chatHistoryManager: { updateLastMessage: vi.fn(() => null), indexOfMessageId: vi.fn(() => -1), append },
      sessionManager: {
        get: vi.fn(() => ({ id: "s1" } as SessionInfo)),
        getSecretBlock: vi.fn(() => undefined),
        setSecretBlock: vi.fn(),
      },
      scheduleAutoPush: vi.fn(),
    } as unknown as Parameters<typeof postTurnCommit>[0];
    return { ctx, append };
  }

  it("reports the failure to the user and still rethrows", async () => {
    const emit = vi.fn();
    const { ctx, append } = makeThrowingCtx(new Error("fatal: Unable to create '/w/.git/index.lock': File exists."));

    await expect(postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit, turnSummary: "a turn",
    })).rejects.toThrow("index.lock");

    expect(append).toHaveBeenCalled();
    const notices = emit.mock.calls.map(([m]) => JSON.stringify(m)).join("\n");
    expect(notices).toContain("NOT committed");
    expect(notices).toContain("index.lock");
  });

  it("rethrows unchanged when there is no session to report into", async () => {
    const { ctx, append } = makeThrowingCtx(new Error("boom"));
    await expect(postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: undefined, emit: vi.fn(), turnSummary: "a turn",
    })).rejects.toThrow("boom");
    expect(append).not.toHaveBeenCalled();
  });
});

describe("postTurnCommit — .git is reconciled before the commit, not only after", () => {
  const chown = vi.mocked(chownWorkspaceGitToSessionWorker);

  function makeCtxWithCommit(autoCommit: ReturnType<typeof vi.fn>) {
    return {
      createGitManager: vi.fn(() => ({ autoCommit, getHeadHash: vi.fn(async () => "head") })),
      chatHistoryManager: { updateLastMessage: vi.fn(() => null), indexOfMessageId: vi.fn(() => -1), append: vi.fn() },
      sessionManager: {
        get: vi.fn(() => ({ id: "s1" } as SessionInfo)),
        getSecretBlock: vi.fn(() => undefined),
        setSecretBlock: vi.fn(),
      },
      scheduleAutoPush: vi.fn(),
    } as unknown as Parameters<typeof postTurnCommit>[0];
  }

  it("chowns before autoCommit AND after it", async () => {
    chown.mockClear();
    const autoCommit = vi.fn(async () => ({
      commitHash: "abc123", conflictedFiles: [], rebaseInProgress: false, secretFindings: [],
    }));

    await postTurnCommit(makeCtxWithCommit(autoCommit), {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "a turn",
    });

    expect(chown).toHaveBeenCalledTimes(2);
    expect(chown.mock.invocationCallOrder[0]).toBeLessThan(autoCommit.mock.invocationCallOrder[0]);
    expect(chown.mock.invocationCallOrder[1]).toBeGreaterThan(autoCommit.mock.invocationCallOrder[0]);
  });

  it("still chowns first when the commit throws — the reported production path", async () => {
    chown.mockClear();
    const err = new Error("fatal: could not open '.git/COMMIT_EDITMSG': Permission denied");
    const autoCommit = vi.fn(() => Promise.reject(err));

    await expect(postTurnCommit(makeCtxWithCommit(autoCommit), {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "a turn",
    })).rejects.toThrow("COMMIT_EDITMSG");

    expect(chown).toHaveBeenCalledTimes(2);
    expect(chown.mock.invocationCallOrder[0]).toBeLessThan(autoCommit.mock.invocationCallOrder[0]);
  });

  it("does not touch .git at all for a kind that never commits", async () => {
    chown.mockClear();
    const ctx = {
      createGitManager: vi.fn(),
      chatHistoryManager: { updateLastMessage: vi.fn(), indexOfMessageId: vi.fn() },
      sessionManager: {
        get: vi.fn(() => ({ id: "s1", kind: "ops" } as SessionInfo)),
        getSecretBlock: vi.fn(() => undefined),
        setSecretBlock: vi.fn(),
      },
      scheduleAutoPush: vi.fn(),
    } as unknown as Parameters<typeof postTurnCommit>[0];

    await postTurnCommit(ctx, {
      sessionDir: "/workspace", sessionId: "s1", emit: vi.fn(), turnSummary: "a turn",
    });

    expect(chown).not.toHaveBeenCalled();
  });
});
