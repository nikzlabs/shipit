import { describe, it, expect, vi } from "vitest";
import { flushPendingTurnCommit } from "./github.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { AutoCommitResult } from "../../shared/git.js";

// docs/213 — flushPendingTurnCommit must report `secretBlocked` so the
// agent-driven PR path can abort instead of silently pushing the prior (stale)
// branch state when the just-made edit was refused for a secret.

function fakeGit(result: AutoCommitResult): GitManager {
  return {
    getHeadHash: vi.fn(async () => "parent"),
    autoCommit: vi.fn(async () => result),
  } as unknown as GitManager;
}

function fakeRunner() {
  return {
    sessionId: "s1",
    turnSummary: "do things",
    clearPushTimer: vi.fn(),
    emitMessage: vi.fn(),
    pendingCommitLink: null as unknown,
  };
}

function registryFor(runner: ReturnType<typeof fakeRunner>): SessionRunnerRegistry {
  return { get: () => runner } as unknown as SessionRunnerRegistry;
}

describe("flushPendingTurnCommit — secret refusal", () => {
  it("returns secretBlocked + a warning notice and makes no commit on a finding", async () => {
    const runner = fakeRunner();
    const git = fakeGit({
      commitHash: null,
      conflictedFiles: [],
      rebaseInProgress: false,
      secretFindings: [
        { rule: "github-pat", description: "GitHub PAT", file: "x.ts", redacted: "ghp_…[redacted, 40 chars]" },
      ],
    });

    const res = await flushPendingTurnCommit(git, { sessionId: "s1", runnerRegistry: registryFor(runner) });

    expect(res.secretBlocked).toBe(true);
    expect(res.commitHash).toBeNull();
    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "system_notice", level: "warn" }),
    );
  });

  it("returns secretBlocked=false on a normal commit", async () => {
    const runner = fakeRunner();
    const git = fakeGit({ commitHash: "abc123", conflictedFiles: [], rebaseInProgress: false, secretFindings: [] });

    const res = await flushPendingTurnCommit(git, { sessionId: "s1", runnerRegistry: registryFor(runner) });

    expect(res.secretBlocked).toBe(false);
    expect(res.commitHash).toBe("abc123");
  });
});
