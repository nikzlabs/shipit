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
