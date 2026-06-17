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
    sessionManager: { get: vi.fn(() => (kind ? ({ id: "s1", kind } as SessionInfo) : undefined)) },
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

  it("runs the normal commit flow for an ops session (only sandbox is gated here)", async () => {
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
      sessionManager: { get: vi.fn(() => undefined) },
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
