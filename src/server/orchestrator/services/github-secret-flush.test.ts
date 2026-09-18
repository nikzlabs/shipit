import { describe, it, expect, vi } from "vitest";
import { flushPendingTurnCommit } from "./github.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { AutoCommitResult } from "../../shared/git.js";

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
  unreadable: null,
    });

    const res = await flushPendingTurnCommit(git, { sessionId: "s1", runnerRegistry: registryFor(runner) });

    expect(res).toEqual({ kind: "blocked-secret" });
    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "system_notice", level: "warn" }),
    );
  });

  it("reports a plain `committed` on a normal commit", async () => {
    const runner = fakeRunner();
    const git = fakeGit({ commitHash: "abc123", conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: null });

    const res = await flushPendingTurnCommit(git, { sessionId: "s1", runnerRegistry: registryFor(runner) });

    expect(res).toEqual({ kind: "committed", commitHash: "abc123" });
  });
});

describe("flushPendingTurnCommit — the states the booleans could not carry", () => {
  it("distinguishes an unresolved conflict from a clean tree", async () => {
    const runner = fakeRunner();
    const conflicted = await flushPendingTurnCommit(
      fakeGit({
        commitHash: null,
        conflictedFiles: ["src/a.ts"],
        rebaseInProgress: false,
        secretFindings: [],
        unreadable: null,
      }),
      { sessionId: "s1", runnerRegistry: registryFor(runner) },
    );
    expect(conflicted).toEqual({
      kind: "blocked-conflict",
      conflictedFiles: ["src/a.ts"],
      rebaseInProgress: false,
    });

    const clean = await flushPendingTurnCommit(
      fakeGit({
        commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: null,
      }),
      { sessionId: "s1", runnerRegistry: registryFor(runner) },
    );
    expect(clean).toEqual({ kind: "nothing-to-commit" });
  });

  it("reports a mid-rebase tree as blocked even with no unmerged paths", async () => {
    const runner = fakeRunner();
    const res = await flushPendingTurnCommit(
      fakeGit({
        commitHash: null,
        conflictedFiles: [],
        rebaseInProgress: true,
        secretFindings: [],
        unreadable: null,
      }),
      { sessionId: "s1", runnerRegistry: registryFor(runner) },
    );
    expect(res.kind).toBe("blocked-conflict");
  });

  it("reports a commit that omitted an unreadable path as partial, not committed", async () => {
    const runner = fakeRunner();
    const res = await flushPendingTurnCommit(
      fakeGit({
        commitHash: "abc123",
        conflictedFiles: [],
        rebaseInProgress: false,
        secretFindings: [],
        unreadable: { kind: "omitted", detail: "pgdata/" },
      }),
      { sessionId: "s1", runnerRegistry: registryFor(runner) },
    );
    expect(res).toEqual({ kind: "partial-unreadable", commitHash: "abc123" });
  });

  it("reports a `clean` tree whose only changes were unreadable as partial", async () => {
    const runner = fakeRunner();
    const res = await flushPendingTurnCommit(
      fakeGit({
        commitHash: null,
        conflictedFiles: [],
        rebaseInProgress: false,
        secretFindings: [],
        unreadable: { kind: "omitted", detail: "pgdata/" },
      }),
      { sessionId: "s1", runnerRegistry: registryFor(runner) },
    );
    expect(res).toEqual({ kind: "partial-unreadable", commitHash: null });
  });
});

describe("flushPendingTurnCommit — unreadable workspace content", () => {
  it("warns that nothing was committed when a file could not be read", async () => {
    const runner = fakeRunner();
    const git = fakeGit({
      commitHash: null,
      conflictedFiles: [],
      rebaseInProgress: false,
      secretFindings: [],
      unreadable: { kind: "blocked", detail: "d/server.key" },
    });

    const res = await flushPendingTurnCommit(git, { sessionId: "s1", runnerRegistry: registryFor(runner) });

    expect(res.kind).toBe("blocked-unreadable");
    const notices = runner.emitMessage.mock.calls.map(([m]) => JSON.stringify(m)).join("\n");
    expect(notices).toContain("server.key");
    expect(notices).toContain("NOT committed");
  });

  it("reports `blocked-unreadable` so the PR path can abort, like the secret one", async () => {
    const runner = fakeRunner();
    const blocked = await flushPendingTurnCommit(
      fakeGit({
        commitHash: null,
        conflictedFiles: [],
        rebaseInProgress: false,
        secretFindings: [],
        unreadable: { kind: "blocked", detail: "d/server.key" },
      }),
      { sessionId: "s1", runnerRegistry: registryFor(runner) },
    );
    expect(blocked.kind).toBe("blocked-unreadable");

    const nothingToCommit = await flushPendingTurnCommit(
      fakeGit({
        commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: null,
      }),
      { sessionId: "s1", runnerRegistry: registryFor(runner) },
    );
    expect(nothingToCommit.kind).toBe("nothing-to-commit");
  });

  it("persists the notice when there is no runner to emit through", async () => {
    const appended: { sessionId: string; text: unknown }[] = [];
    const chatHistory = {
      append: (sessionId: string, message: { text?: string }) => {
        appended.push({ sessionId, text: message.text });
      },
    };

    await flushPendingTurnCommit(
      fakeGit({
        commitHash: null,
        conflictedFiles: [],
        rebaseInProgress: false,
        secretFindings: [],
        unreadable: { kind: "blocked", detail: "d/server.key" },
      }),
      {
        sessionId: "s1",
        runnerRegistry: { get: () => undefined } as unknown as SessionRunnerRegistry,
        chatHistory: chatHistory as never,
      },
    );

    expect(appended).toHaveLength(1);
    expect(String(appended[0]!.text)).toContain("server.key");
  });

  it("warns that the commit is short when a directory could not be read", async () => {
    const runner = fakeRunner();
    const git = fakeGit({
      commitHash: "abc123",
      conflictedFiles: [],
      rebaseInProgress: false,
      secretFindings: [],
      unreadable: { kind: "omitted", detail: "pgdata/" },
    });

    const res = await flushPendingTurnCommit(git, { sessionId: "s1", runnerRegistry: registryFor(runner) });

    expect(res).toEqual({ kind: "partial-unreadable", commitHash: "abc123" });
    const notices = runner.emitMessage.mock.calls.map(([m]) => JSON.stringify(m)).join("\n");
    expect(notices).toContain("pgdata/");
    expect(notices).toContain("short");
  });
});
