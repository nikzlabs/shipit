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

/**
 * docs/287-agent-merge-per-repo req 15 — the two states the old booleans could
 * not express. Both are "the branch does not carry this turn's work", and both
 * used to arrive as `{ commitHash: null | hash, secretBlocked: false,
 * unreadableBlocked: false }` — the exact shape of a healthy flush.
 */
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
    // Same null hash as a clean tree, and that is the whole point: a merge that
    // read only the hash would ship a branch missing this turn's work.
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
    // The hash is kept — the commit is real — but the kind says it is short.
    expect(res).toEqual({ kind: "partial-unreadable", commitHash: "abc123" });
  });

  it("reports a `clean` tree whose only changes were unreadable as partial", async () => {
    // The measured case from docs/266: git says "working tree clean", exits 0,
    // and warns on stderr. Nothing distinguishes it from a real clean tree
    // except this field, and calling it `nothing-to-commit` would let a merge
    // proceed on a branch missing everything the turn changed.
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

/**
 * docs/266-orchestrator-git-trust-boundary reqs 14 + 15 / planning#407 — this flush ignored the `unreadable`
 * field entirely, so a `blocked` add returned the same null hash as "nothing to
 * commit" and the caller went on to push and open a PR without the work the
 * flush existed to include. Silently.
 */
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
    // The caller-facing half. `commitHash: null` alone cannot carry this: it is
    // also the ordinary "nothing to commit" answer, and aborting on that would
    // refuse every PR opened on an already-clean tree.
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
    // A consult landing after its parent turn can find no runner. The runner is
    // the live transport, not the record — and "your work is not on the branch"
    // is exactly the fact that has to survive to the transcript.
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

    // The commit still lands — the notice is about what is missing FROM it.
    expect(res).toEqual({ kind: "partial-unreadable", commitHash: "abc123" });
    const notices = runner.emitMessage.mock.calls.map(([m]) => JSON.stringify(m)).join("\n");
    expect(notices).toContain("pgdata/");
    expect(notices).toContain("short");
  });
});
