import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAutoPushScheduler,
  MAX_PUSH_DEFERRALS,
  PUSH_DEFER_RETRY_MS,
  type AutoPushDeps,
} from "./auto-push-scheduler.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { isOpsSafeLine } from "./host-session-logs.js";

function fakeGit(overrides: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
  return {
    getRemotes: vi.fn(async () => [{ name: "origin", url: "https://github.com/o/r.git" }]),
    getCurrentBranch: vi.fn(async () => "shipit/feature"),
    push: vi.fn(async () => {}),
    isRebaseInProgress: vi.fn(async () => false),
    currentBranchOrNull: vi.fn(async () => "shipit/feature"),
    fetchBranch: vi.fn(async () => {}),
    aheadBehind: vi.fn(async () => ({ ahead: 1, behind: 1 })),
    mergeBase: vi.fn(async () => "abc1234"),
    commitSubjects: vi.fn(async () => []),
    ...overrides,
  } as unknown as GitManager;
}

type FakeRunner = SessionRunnerInterface & {
  emitMessage: ReturnType<typeof vi.fn>;
  beginPostTurnWork: ReturnType<typeof vi.fn>;
  endPostTurnWork: ReturnType<typeof vi.fn>;
};

function fakeRunner(): FakeRunner {
  return {
    sessionId: "s1",
    emitMessage: vi.fn(),
    beginPostTurnWork: vi.fn(),
    endPostTurnWork: vi.fn(),
    systemTurnInProgress: false,
  } as unknown as FakeRunner;
}

interface AppendedRow { notice?: boolean; noticeLevel?: string; text?: string }

type TestDeps = AutoPushDeps & {
  broadcastLog: ReturnType<typeof vi.fn>;
  notifyAutoPush: ReturnType<typeof vi.fn>;
  chatHistory: { append: ReturnType<typeof vi.fn> };
  appended: AppendedRow[];
};

function makeDeps(overrides: Partial<AutoPushDeps> = {}): TestDeps {
  const appended: AppendedRow[] = [];
  return {
    debounceMs: 5000,
    githubAuthManager: { authenticated: true, markTokenInvalid: vi.fn(async () => true) },
    getRunner: () => null,
    broadcastLog: vi.fn(),
    chatHistory: { append: vi.fn((_sessionId: string, m: AppendedRow) => { appended.push(m); }) },
    notifyAutoPush: vi.fn(),
    appended,
    ...overrides,
  } as TestDeps;
}

function appendedNotices(deps: TestDeps): string[] {
  return deps.appended.filter((m) => m.notice).map((m) => m.text ?? "");
}

function divergedGit(
  counts: { ahead: number; behind: number } = { ahead: 1, behind: 1 },
  extra: Partial<Record<keyof GitManager, unknown>> = {},
): GitManager {
  return fakeGit({
    push: vi.fn(async () => {
      throw new Error(
        "Updates were rejected because the tip of your current branch is behind (non-fast-forward)",
      );
    }),
    aheadBehind: vi.fn(async () => counts),
    ...extra,
  });
}

async function fireDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5000);
  await vi.waitFor(() => {});
}

describe("auto-push scheduler — the push does not depend on a runner", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("pushes after the debounce even when the session has no runner at all", async () => {
    const deps = makeDeps({ getRunner: () => null });
    const git = fakeGit();
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    expect(git.push).toHaveBeenCalledWith("origin", "shipit/feature");
  });

  it("still pushes when the runner disappears between arming and firing", async () => {
    let runner: SessionRunnerInterface | null = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    const git = fakeGit();
    createAutoPushScheduler(deps).schedule(git, "s1");

    runner = null;

    await fireDebounce();

    expect(git.push).toHaveBeenCalledTimes(1);
  });

  it("reports success to a live runner and bumps the PR poller's cadence", async () => {
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    createAutoPushScheduler(deps).schedule(fakeGit(), "s1");

    await fireDebounce();

    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "github_push_result", success: true, branch: "shipit/feature" }),
    );
    expect(deps.notifyAutoPush).toHaveBeenCalledWith("s1");
  });

  it("says on the log ring that the push LANDED, in counts only (docs/264)", async () => {
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(fakeGit({ aheadBehind: vi.fn(async () => ({ ahead: 3, behind: 0 })) }), "s1");

    await fireDebounce();

    const lines = deps.broadcastLog.mock.calls.filter((c) => c[1] === "server").map((c) => c[2] as string);
    const completed = lines.filter((t) => t.startsWith("Auto-push completed"));
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatch(
      /^Auto-push completed in \d+ms: 3 commit\(s\) were ahead of the last known remote tip\.$/,
    );
    expect(completed[0]).not.toContain("shipit/feature");
    expect(isOpsSafeLine(completed[0])).toBe(true);
  });

  it("distinguishes a turn that pushed nothing from a push that failed", async () => {
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(fakeGit({ aheadBehind: vi.fn(async () => ({ ahead: 0, behind: 0 })) }), "s1");

    await fireDebounce();

    const line = deps.broadcastLog.mock.calls.map((c) => c[2] as string)
      .find((t) => t.startsWith("Auto-push completed"));
    expect(line).toContain("nothing was ahead of the last known remote tip");
    expect(isOpsSafeLine(line ?? "")).toBe(true);
  });

  it("reports an unmeasurable count as unmeasured, never as zero commits", async () => {
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(fakeGit({ aheadBehind: vi.fn(async () => null) }), "s1");

    await fireDebounce();

    const line = deps.broadcastLog.mock.calls.map((c) => c[2] as string)
      .find((t) => t.startsWith("Auto-push completed"));
    expect(line).toContain("the commit count could not be measured");
    expect(isOpsSafeLine(line ?? "")).toBe(true);
  });

  it("a probe that throws costs the count, never the push", async () => {
    const deps = makeDeps();
    const git = fakeGit({ aheadBehind: vi.fn(async () => { throw new Error("unreadable .git"); }) });
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    expect(git.push).toHaveBeenCalledWith("origin", "shipit/feature");
    const line = deps.broadcastLog.mock.calls.map((c) => c[2] as string)
      .find((t) => t.startsWith("Auto-push completed"));
    expect(line).toContain("the commit count could not be measured");
  });

  it("a throw from the post-push bookkeeping does not turn a landed push into a failure", async () => {
    const runner = fakeRunner();
    runner.emitMessage.mockImplementation((m: { type: string }) => {
      if (m.type === "github_push_result") throw new Error("Authentication failed: viewer transport is wedged");
    });
    const deps = makeDeps({
      getRunner: () => runner,
      notifyAutoPush: vi.fn(() => { throw new Error("poller is wedged"); }),
    });
    const git = fakeGit();
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    const lines = deps.broadcastLog.mock.calls.map((c) => c[2] as string);
    expect(lines.some((t) => t.startsWith("Auto-push completed"))).toBe(true);
    expect(lines.some((t) => t.startsWith("Auto-push failed"))).toBe(false);
    expect(lines.some((t) => t.startsWith("Git said: "))).toBe(false);
    expect(deps.githubAuthManager.markTokenInvalid).not.toHaveBeenCalled();
  });

  it("splits a push failure into ShipIt's class and git's own words", async () => {
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(
      fakeGit({
        push: vi.fn(async () => { throw new Error("error: RPC failed while writing /workspace/secret"); }),
      }),
      "s1",
    );

    await fireDebounce();

    const lines = deps.broadcastLog.mock.calls.map((c) => c[2] as string);
    const opsSafe = lines.filter((t) => isOpsSafeLine(t));
    expect(opsSafe).toHaveLength(1);
    expect(opsSafe[0]).toMatch(/^Auto-push failed \([a-z-]+\)\. /);
    expect(opsSafe[0]).not.toContain("/workspace/secret");
    expect(lines.some((t) => t.startsWith("Git said: ") && t.includes("/workspace/secret"))).toBe(true);
  });

  it("re-arming replaces the pending push rather than stacking a second one", async () => {
    const deps = makeDeps();
    const git = fakeGit();
    const scheduler = createAutoPushScheduler(deps);
    scheduler.schedule(git, "s1");
    await vi.advanceTimersByTimeAsync(3000);
    scheduler.schedule(git, "s1");

    await fireDebounce();

    expect(git.push).toHaveBeenCalledTimes(1);
  });

  it("holds the runner's post-turn lease from arming until the push completes", async () => {
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    createAutoPushScheduler(deps).schedule(fakeGit(), "s1");

    expect(runner.beginPostTurnWork).toHaveBeenCalledTimes(1);
    expect(runner.endPostTurnWork).not.toHaveBeenCalled();

    await fireDebounce();

    expect(runner.endPostTurnWork).toHaveBeenCalledTimes(1);
  });

  it("releases the post-turn lease when a pending push is cancelled", () => {
    const runner = fakeRunner();
    const scheduler = createAutoPushScheduler(makeDeps({ getRunner: () => runner }));
    scheduler.schedule(fakeGit(), "s1");
    scheduler.cancel("s1");

    expect(runner.endPostTurnWork).toHaveBeenCalledTimes(1);
  });

  it("releases the post-turn lease even when the push throws", async () => {
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    const git = fakeGit({ push: vi.fn(async () => { throw new Error("boom"); }) });
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    expect(runner.endPostTurnWork).toHaveBeenCalledTimes(1);
  });

  it("releases the lease on the runner that took it when the runner is replaced before the push fires", async () => {
    const original = fakeRunner();
    const successor = fakeRunner();
    let current: SessionRunnerInterface | null = original;
    const deps = makeDeps({ getRunner: () => current });
    const git = fakeGit();
    createAutoPushScheduler(deps).schedule(git, "s1");
    expect(original.beginPostTurnWork).toHaveBeenCalledTimes(1);

    current = successor;

    await fireDebounce();

    expect(original.endPostTurnWork).toHaveBeenCalledTimes(1);
    expect(successor.endPostTurnWork).not.toHaveBeenCalled();
    expect(git.push).toHaveBeenCalledTimes(1);
  });

  it("releases the original runner's lease when the pending push is cancelled after a runner replacement", () => {
    const original = fakeRunner();
    const successor = fakeRunner();
    let current: SessionRunnerInterface | null = original;
    const scheduler = createAutoPushScheduler(makeDeps({ getRunner: () => current }));
    scheduler.schedule(fakeGit(), "s1");
    current = successor;

    scheduler.cancel("s1");

    expect(original.endPostTurnWork).toHaveBeenCalledTimes(1);
    expect(successor.endPostTurnWork).not.toHaveBeenCalled();
  });

  it("superseding a pending push releases the old runner's lease and holds the current one for the replacement", async () => {
    const original = fakeRunner();
    const successor = fakeRunner();
    let current: SessionRunnerInterface | null = original;
    const deps = makeDeps({ getRunner: () => current });
    const git = fakeGit();
    const scheduler = createAutoPushScheduler(deps);
    scheduler.schedule(git, "s1");
    current = successor;
    scheduler.schedule(git, "s1");

    expect(original.beginPostTurnWork).toHaveBeenCalledTimes(1);
    expect(original.endPostTurnWork).toHaveBeenCalledTimes(1);
    expect(successor.beginPostTurnWork).toHaveBeenCalledTimes(1);
    expect(successor.endPostTurnWork).not.toHaveBeenCalled();

    await fireDebounce();

    expect(original.endPostTurnWork).toHaveBeenCalledTimes(1);
    expect(successor.endPostTurnWork).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledTimes(1);
  });

  it("keeps each runner's lease balanced when a deferred push retries across a runner replacement", async () => {
    const original = fakeRunner();
    const successor = fakeRunner();
    let current: SessionRunnerInterface | null = original;
    const deps = makeDeps({ getRunner: () => current });
    let probes = 0;
    const git = fakeGit({
      isRebaseInProgress: vi.fn(async () => { probes++; return probes === 1; }),
    });
    createAutoPushScheduler(deps).schedule(git, "s1");
    current = successor;

    await fireDebounce();
    expect(original.beginPostTurnWork.mock.calls.length).toBe(original.endPostTurnWork.mock.calls.length);
    expect(successor.beginPostTurnWork.mock.calls.length - successor.endPostTurnWork.mock.calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(PUSH_DEFER_RETRY_MS);
    await vi.waitFor(() => {});

    expect(git.push).toHaveBeenCalledTimes(1);
    expect(successor.beginPostTurnWork.mock.calls.length).toBe(successor.endPostTurnWork.mock.calls.length);
  });

  it("cancel drops a pending push", async () => {
    const deps = makeDeps();
    const git = fakeGit();
    const scheduler = createAutoPushScheduler(deps);
    scheduler.schedule(git, "s1");
    expect(scheduler.pending("s1")).toBe(true);

    scheduler.cancel("s1");
    await fireDebounce();

    expect(scheduler.pending("s1")).toBe(false);
    expect(git.push).not.toHaveBeenCalled();
  });

  it("keys pending pushes per session", async () => {
    const deps = makeDeps();
    const gitA = fakeGit();
    const gitB = fakeGit({ getCurrentBranch: vi.fn(async () => "shipit/other") });
    const scheduler = createAutoPushScheduler(deps);
    scheduler.schedule(gitA, "s1");
    scheduler.schedule(gitB, "s2");
    scheduler.cancel("s1");

    await fireDebounce();

    expect(gitA.push).not.toHaveBeenCalled();
    expect(gitB.push).toHaveBeenCalledTimes(1);
  });
});

describe("auto-push scheduler — a push that cannot happen is never silent", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("warns, naming the session, when GitHub is not connected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({
      githubAuthManager: { authenticated: false, markTokenInvalid: vi.fn(async () => false) },
    });
    const git = fakeGit();
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    expect(git.push).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("s1");
  });

  it("warns when there is no session id to arm a push against", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createAutoPushScheduler(makeDeps()).schedule(fakeGit(), undefined);
    expect(warn).toHaveBeenCalled();
  });

  it("says so on the server log when shutdown drops an armed push", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scheduler = createAutoPushScheduler(makeDeps());
    scheduler.schedule(fakeGit(), "s1");
    scheduler.schedule(fakeGit(), "s2");

    scheduler.cancelAll();

    const warned = warn.mock.calls.flat().join(" ");
    expect(warned).toContain("s1");
    expect(warned).toContain("s2");
    expect(warned).toContain("shutdown");
    expect(scheduler.pending("s1")).toBe(false);
  });

  it("records a failed push in the session log even with no runner attached", async () => {
    const deps = makeDeps({
      getRunner: () => null,
      githubAuthManager: { authenticated: true, markTokenInvalid: vi.fn(async () => false) },
    });
    const git = fakeGit({ push: vi.fn(async () => { throw new Error("remote hung up"); }) });
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    expect(deps.broadcastLog).toHaveBeenCalledWith(
      "s1",
      "server",
      expect.stringContaining("remote hung up"),
    );
  });

  it("records a diverged branch in the session log even with no runner attached", async () => {
    const deps = makeDeps({ getRunner: () => null });
    const git = fakeGit({
      push: vi.fn(async () => { throw new Error("Updates were rejected because the tip of your current branch is behind (non-fast-forward)"); }),
    });
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    expect(deps.broadcastLog).toHaveBeenCalledWith(
      "s1",
      "server",
      expect.stringContaining("diverged"),
    );
  });

  it("still explains the failure when marking the token invalid throws", async () => {
    const runner = fakeRunner();
    const deps = makeDeps({
      getRunner: () => runner,
      githubAuthManager: {
        authenticated: true,
        markTokenInvalid: vi.fn(async () => { throw new Error("github unreachable"); }),
      },
    });
    const git = fakeGit({ push: vi.fn(async () => { throw new Error("Authentication failed"); }) });
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    const lines = deps.broadcastLog.mock.calls.map((c) => c[2] as string);
    expect(lines).toContain("Auto-push failed (auth). The commit stays in this session's local history.");
    expect(lines).toContain("Git said: Authentication failed");
    expect(lines.filter((t) => isOpsSafeLine(t))).toHaveLength(1);
    expect(runner.endPostTurnWork).toHaveBeenCalledTimes(1);
  });

  it("splits the GH008 report too, and its authored half is now a whole line", async () => {
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(
      fakeGit({
        push: vi.fn(async () => { throw new Error("remote: GH008: unknown Git LFS object for /workspace/big.bin"); }),
      }),
      "s1",
    );

    await fireDebounce();

    const lines = deps.broadcastLog.mock.calls.map((c) => c[2] as string);
    const opsSafe = lines.filter((t) => isOpsSafeLine(t));
    expect(opsSafe).toHaveLength(1);
    expect(opsSafe[0]).toContain("Git LFS objects were not uploaded (GH008)");
    expect(opsSafe[0]).not.toContain("/workspace/big.bin");
    expect(lines.some((t) => t.startsWith("Git said: ") && t.includes("/workspace/big.bin"))).toBe(true);
  });

  it("releases the lease and logs when reporting the outcome itself throws", async () => {
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    deps.broadcastLog.mockImplementation(() => { throw new Error("log ring exploded"); });
    const git = fakeGit({ push: vi.fn(async () => { throw new Error("boom"); }) });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    expect(error).toHaveBeenCalled();
    expect(runner.endPostTurnWork).toHaveBeenCalledTimes(1);
  });

  it("puts every no-push path on the server log, not just in the session's log ring", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({ getRunner: () => null });
    createAutoPushScheduler(deps).schedule(divergedGit(), "s1");

    await fireDebounce();

    const warned = warn.mock.calls.flat().join(" ");
    expect(warned).toContain("s1");
    expect(warned).toContain("diverged");
  });

  it("names WHICH condition made pushToOrigin skip — no origin, or no branch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const noOrigin = makeDeps();
    createAutoPushScheduler(noOrigin).schedule(fakeGit({ getRemotes: vi.fn(async () => []) }), "s1");
    await fireDebounce();
    expect(noOrigin.broadcastLog).toHaveBeenCalledWith("s1", "server", expect.stringContaining("`origin` remote"));

    const noBranch = makeDeps();
    createAutoPushScheduler(noBranch).schedule(fakeGit({ getCurrentBranch: vi.fn(async () => null) }), "s2");
    await fireDebounce();
    expect(noBranch.broadcastLog).toHaveBeenCalledWith("s2", "server", expect.stringContaining("detached HEAD"));

    expect(warn.mock.calls.flat().join(" ")).toContain("detached HEAD");
  });

  it("invalidates the stored token and says so when the remote rejects the credential", async () => {
    const markTokenInvalid = vi.fn(async () => true);
    const runner = fakeRunner();
    const deps = makeDeps({
      getRunner: () => runner,
      githubAuthManager: { authenticated: true, markTokenInvalid },
    });
    const git = fakeGit({ push: vi.fn(async () => { throw new Error("Authentication failed"); }) });
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    expect(markTokenInvalid).toHaveBeenCalled();
    expect(deps.broadcastLog).toHaveBeenCalledWith(
      "s1",
      "server",
      expect.stringContaining("invalid or expired"),
    );
  });
});

describe("auto-push scheduler — a rejected push leaves a transcript notice", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("persists a notice that names the branch, the reason, and the remedy", async () => {
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(divergedGit(), "s1");

    await fireDebounce();

    const notices = appendedNotices(deps);
    expect(notices).toHaveLength(1);
    const notice = notices[0];
    expect(notice).toContain("Not pushed");
    expect(notice).toContain("shipit/feature");
    expect(notice).toContain("non-fast-forward");
    expect(notice).toContain("git pull --rebase origin shipit/feature");
    expect(deps.chatHistory.append).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ notice: true, noticeLevel: "warn" }),
    );
  });

  it("measures the shape at the rejection and names the recovery that fits it", async () => {
    const deps = makeDeps();
    const git = divergedGit({ ahead: 0, behind: 1 }, {
      commitSubjects: vi.fn(async () => [{ sha: "d4f3ff4", subject: "Add the exporter" }]),
    });
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    const notice = appendedNotices(deps)[0];
    expect(notice).toContain("1 commit only on the remote");
    expect(notice).toContain("d4f3ff4 Add the exporter");
    expect(notice).toContain("git pull --rebase origin shipit/feature");
    expect(notice).toContain("Do NOT force-push");
    expect(notice).not.toContain("reset-to-base");
  });

  it("tells the reader the agent is blocked from the force-push it just named", async () => {
    const deps = makeDeps({ destructiveGitGuarded: () => true });
    createAutoPushScheduler(deps).schedule(divergedGit({ ahead: 2, behind: 1 }), "s1");

    await fireDebounce();

    const notice = appendedNotices(deps)[0];
    expect(notice).toContain("the user can run it from the terminal");
    expect(notice).toContain('shipit branch reset-to-base --force --reason "<why>"');
  });

  it("omits the blocked note when the guard reports the session is not on a merged branch", async () => {
    const guard = vi.fn(() => false);
    const deps = makeDeps({ destructiveGitGuarded: guard });
    createAutoPushScheduler(deps).schedule(divergedGit({ ahead: 2, behind: 1 }), "s1");

    await fireDebounce();

    expect(guard).toHaveBeenCalledWith("s1");
    expect(appendedNotices(deps)[0]).not.toContain("reset-to-base");
  });

  it("survives a guard reader that throws, and names the ordinary force-push", async () => {
    const deps = makeDeps({ destructiveGitGuarded: () => { throw new Error("session row gone"); } });
    createAutoPushScheduler(deps).schedule(divergedGit({ ahead: 2, behind: 1 }), "s1");

    await fireDebounce();

    expect(appendedNotices(deps)[0]).toContain("git push --force-with-lease origin shipit/feature");
  });

  it("withholds the rebase banner when its force-push would discard the remote's only copy", async () => {
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    createAutoPushScheduler(deps).schedule(divergedGit({ ahead: 0, behind: 1 }), "s1");

    await fireDebounce();

    const rejected = runner.emitMessage.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((m) => m.type === "git_push_rejected");
    expect(rejected).toHaveLength(0);
    expect(appendedNotices(deps)[0]).toContain("git pull --rebase origin shipit/feature");
  });

  it("still arms the rebase banner for the rewritten branch it repairs", async () => {
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    createAutoPushScheduler(deps).schedule(divergedGit({ ahead: 2, behind: 1 }), "s1");

    await fireDebounce();

    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "git_push_rejected", reason: "non_fast_forward" }),
    );
  });

  it("withholds the rebase banner when the shape could not be measured", async () => {
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    createAutoPushScheduler(deps).schedule(
      divergedGit({ ahead: 0, behind: 0 }, { aheadBehind: vi.fn(async () => null) }),
      "s1",
    );

    await fireDebounce();

    expect(runner.emitMessage.mock.calls.map((c) => (c[0] as { type: string }).type))
      .not.toContain("git_push_rejected");
  });

  it("logs the measured shape for the operator, not only the transcript", async () => {
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(divergedGit({ ahead: 0, behind: 3 }), "s1");

    await fireDebounce();

    expect(deps.broadcastLog).toHaveBeenCalledWith(
      "s1",
      "server",
      "Divergence shape: 0 commit(s) only in this session, 3 commit(s) only on the remote branch."
      + " A force-push would discard 3 commit(s) from the remote.",
    );
  });

  it("still persists a notice when the shape cannot be measured", async () => {
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(
      divergedGit({ ahead: 0, behind: 0 }, { aheadBehind: vi.fn(async () => null) }),
      "s1",
    );

    await fireDebounce();

    const notice = appendedNotices(deps)[0];
    expect(notice).toContain("could not measure");
    expect(notice).not.toContain("--force-with-lease");
  });

  it("persists the notice even when the session has no runner left to emit to", async () => {
    const deps = makeDeps({ getRunner: () => null });
    createAutoPushScheduler(deps).schedule(divergedGit(), "s1");

    await fireDebounce();

    expect(appendedNotices(deps)).toHaveLength(1);
  });

  it("emits the notice live to an attached runner as well", async () => {
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    createAutoPushScheduler(deps).schedule(divergedGit(), "s1");

    await fireDebounce();

    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "system_notice", level: "warn", sessionId: "s1" }),
    );
  });

  it("notifies once per divergence episode, not once per rejection", async () => {
    const deps = makeDeps();
    const git = divergedGit();
    const scheduler = createAutoPushScheduler(deps);

    for (let i = 0; i < 5; i++) {
      scheduler.schedule(git, "s1");
      await fireDebounce();
    }

    expect(git.push).toHaveBeenCalledTimes(5);
    expect(appendedNotices(deps)).toHaveLength(1);
    expect(deps.broadcastLog.mock.calls.filter((c) => String(c[2]).includes("diverged"))).toHaveLength(5);
  });

  it("notifies again when a healed divergence recurs", async () => {
    const deps = makeDeps();
    const scheduler = createAutoPushScheduler(deps);

    scheduler.schedule(divergedGit(), "s1");
    await fireDebounce();
    expect(appendedNotices(deps)).toHaveLength(1);

    scheduler.schedule(fakeGit(), "s1");
    await fireDebounce();

    scheduler.schedule(divergedGit(), "s1");
    await fireDebounce();
    expect(appendedNotices(deps)).toHaveLength(2);
  });

  it("ends the episode when a synchronous gh-pr-create push replaces the debounced one", async () => {
    const deps = makeDeps();
    const scheduler = createAutoPushScheduler(deps);

    scheduler.schedule(divergedGit(), "s1");
    await fireDebounce();
    expect(appendedNotices(deps)).toHaveLength(1);

    scheduler.cancel("s1");

    scheduler.schedule(divergedGit(), "s1");
    await fireDebounce();
    expect(appendedNotices(deps)).toHaveLength(2);
  });

  it("does not end the episode merely because the next turn re-arms the push", async () => {
    const deps = makeDeps();
    const git = divergedGit();
    const scheduler = createAutoPushScheduler(deps);

    scheduler.schedule(git, "s1");
    scheduler.schedule(git, "s1");
    await fireDebounce();
    scheduler.schedule(git, "s1");
    await fireDebounce();

    expect(appendedNotices(deps)).toHaveLength(1);
  });

  it("persists the notice even when the log ring and the viewer transport both throw", async () => {
    const runner = fakeRunner();
    runner.emitMessage.mockImplementation(() => { throw new Error("socket is gone"); });
    const deps = makeDeps({ getRunner: () => runner });
    deps.broadcastLog.mockImplementation(() => { throw new Error("log ring exploded"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    createAutoPushScheduler(deps).schedule(divergedGit(), "s1");

    await fireDebounce();

    expect(appendedNotices(deps)).toHaveLength(1);
    expect(runner.endPostTurnWork).toHaveBeenCalledTimes(1);
  });

  it("still records the rejection when the notice itself fails, and retries it next time", async () => {
    const deps = makeDeps();
    deps.chatHistory.append.mockImplementationOnce(() => { throw new Error("db locked"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduler = createAutoPushScheduler(deps);

    scheduler.schedule(divergedGit(), "s1");
    await fireDebounce();

    expect(error).toHaveBeenCalled();
    expect(deps.broadcastLog).toHaveBeenCalledWith("s1", "server", expect.stringContaining("diverged"));
    expect(appendedNotices(deps)).toHaveLength(0);

    scheduler.schedule(divergedGit(), "s1");
    await fireDebounce();
    expect(appendedNotices(deps)).toHaveLength(1);
  });

  it("still notifies when the branch name cannot be re-read after the rejection", async () => {
    const deps = makeDeps();
    const git = fakeGit({
      getCurrentBranch: vi.fn()
        .mockImplementationOnce(async () => "shipit/feature")
        .mockImplementationOnce(async () => { throw new Error("git is unhappy"); }),
      push: vi.fn(async () => {
        throw new Error(" ! [rejected] shipit/feature -> shipit/feature (fetch first)\nerror: failed to push some refs");
      }),
    });
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    const notices = appendedNotices(deps);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Not pushed");
    expect(notices[0]).not.toContain("undefined");
  });

  it("leaves no notice on a push that succeeds", async () => {
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(fakeGit(), "s1");

    await fireDebounce();

    expect(appendedNotices(deps)).toHaveLength(0);
  });
});

describe("auto-push scheduler — a rejection explained by our own rebase is not a divergence", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function rebasingThenHealedGit(): GitManager {
    let probes = 0;
    return fakeGit({
      isRebaseInProgress: vi.fn(async () => { probes++; return probes === 1; }),
    });
  }

  it("does not even attempt the push while a rebase is in flight", async () => {
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    const git = fakeGit({ isRebaseInProgress: vi.fn(async () => true) });
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    expect(git.push).not.toHaveBeenCalled();
    expect(appendedNotices(deps)).toHaveLength(0);
    expect(runner.emitMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "git_push_rejected" }),
    );
  });

  it("persists no notice and raises no rebase banner for a rejection inside the window", async () => {
    const runner = fakeRunner();
    runner.systemTurnInProgress = true;
    const deps = makeDeps({ getRunner: () => runner });
    createAutoPushScheduler(deps).schedule(divergedGit(), "s1");

    await fireDebounce();

    expect(appendedNotices(deps)).toHaveLength(0);
    expect(runner.emitMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "git_push_rejected" }),
    );
  });

  it("does NOT hold back a push that would succeed merely because a system turn is running", async () => {
    const runner = fakeRunner();
    runner.systemTurnInProgress = true;
    const deps = makeDeps({ getRunner: () => runner });
    const git = fakeGit();
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();

    expect(git.push).toHaveBeenCalledTimes(1);
    expect(deps.notifyAutoPush).toHaveBeenCalledWith("s1");
  });

  it("still says so on the operator's log and in the session log ring", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(
      fakeGit({ isRebaseInProgress: vi.fn(async () => true) }),
      "s1",
    );

    await fireDebounce();

    expect(warn.mock.calls.some((c) => String(c[0]).includes("deferred"))).toBe(true);
    expect(deps.broadcastLog).toHaveBeenCalledWith("s1", "server", expect.stringContaining("deferred"));
  });

  it("retries the deferred push, so the commit still reaches origin", async () => {
    const deps = makeDeps();
    const git = rebasingThenHealedGit();
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();
    expect(git.push).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PUSH_DEFER_RETRY_MS);
    await vi.waitFor(() => {});

    expect(git.push).toHaveBeenCalledTimes(1);
    expect(appendedNotices(deps)).toHaveLength(0);
    expect(deps.notifyAutoPush).toHaveBeenCalledWith("s1");
  });

  it("keeps the post-turn lease balanced across a deferral and its retry", async () => {
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    createAutoPushScheduler(deps).schedule(rebasingThenHealedGit(), "s1");

    await fireDebounce();
    expect(runner.beginPostTurnWork.mock.calls.length - runner.endPostTurnWork.mock.calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(PUSH_DEFER_RETRY_MS);
    await vi.waitFor(() => {});

    expect(runner.beginPostTurnWork.mock.calls.length).toBe(runner.endPostTurnWork.mock.calls.length);
  });

  it("reports the rejection normally once the rewrite window refuses to close", async () => {
    const deps = makeDeps();
    const git = fakeGit({
      isRebaseInProgress: vi.fn(async () => true),
      push: vi.fn(async () => {
        throw new Error("Updates were rejected because the tip of your current branch is behind");
      }),
    });
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();
    for (let i = 0; i <= MAX_PUSH_DEFERRALS; i++) {
      await vi.advanceTimersByTimeAsync(PUSH_DEFER_RETRY_MS);
      await vi.waitFor(() => {});
    }

    expect(appendedNotices(deps)).toHaveLength(1);
    expect(appendedNotices(deps)[0]).toContain("Not pushed");
  });

  it("leaves a genuine divergence loud — no rebase, no runner flag, full notice", async () => {
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    createAutoPushScheduler(deps).schedule(divergedGit(), "s1");

    await fireDebounce();

    expect(appendedNotices(deps)).toHaveLength(1);
    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "git_push_rejected" }),
    );
  });

  it("stays loud when the rebase probe itself cannot answer", async () => {
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(
      fakeGit({
        isRebaseInProgress: vi.fn(async () => { throw new Error("unreadable .git"); }),
        push: vi.fn(async () => {
          throw new Error("Updates were rejected because the tip of your current branch is behind");
        }),
      }),
      "s1",
    );

    await fireDebounce();

    expect(appendedNotices(deps)).toHaveLength(1);
  });
});
