import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAutoPushScheduler, type AutoPushDeps } from "./auto-push-scheduler.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionRunnerInterface } from "../session-runner.js";

/**
 * The incident this file pins: a post-turn commit landed and its push silently
 * never happened, because the debounce timer lived on the session's runner and
 * the runner was disposed 150ms before the commit finished.
 *
 * These assert the *observable* outcome — the push happens, or something says
 * why it didn't — never the internal call shape, so a later rework of the
 * scheduler does not have to fight its own tests.
 */

function fakeGit(overrides: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
  return {
    getRemotes: vi.fn(async () => [{ name: "origin", url: "https://github.com/o/r.git" }]),
    getCurrentBranch: vi.fn(async () => "shipit/feature"),
    push: vi.fn(async () => {}),
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
  } as unknown as FakeRunner;
}

function makeDeps(overrides: Partial<AutoPushDeps> = {}): AutoPushDeps & {
  broadcastLog: ReturnType<typeof vi.fn>;
  notifyAutoPush: ReturnType<typeof vi.fn>;
} {
  return {
    debounceMs: 5000,
    githubAuthManager: { authenticated: true, markTokenInvalid: vi.fn(async () => true) },
    getRunner: () => null,
    broadcastLog: vi.fn(),
    notifyAutoPush: vi.fn(),
    ...overrides,
  } as AutoPushDeps & {
    broadcastLog: ReturnType<typeof vi.fn>;
    notifyAutoPush: ReturnType<typeof vi.fn>;
  };
}

/** Fire the debounce and let the async push body settle. */
async function fireDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5000);
  await vi.waitFor(() => {});
}

describe("auto-push scheduler — the push does not depend on a runner", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("pushes after the debounce even when the session has no runner at all", async () => {
    // The reproduction. Before this module the scheduler resolved a runner and
    // returned silently when there was none — a runner disposed between the
    // commit and the 5s debounce took the whole push with it.
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

    // The idle enforcer reclaims the session while the push is armed. Disposal
    // used to run `clearPushTimer()` and cancel it.
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
    // `post-turn-hold.ts` is what stops a reclaim pass destroying the container
    // the branch is being pushed from. Moving the timer off the runner must not
    // move that protection off with it, so the scheduler takes the lease itself.
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
    // `markTokenInvalid` verifies against the GitHub API and emits an event, so
    // it can reject. An unguarded await here skipped the report entirely and
    // turned the whole push failure into an unhandled rejection — the swallowed
    // outcome this module exists to end.
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

    expect(deps.broadcastLog).toHaveBeenCalledWith(
      "s1",
      "server",
      expect.stringContaining("Authentication failed"),
    );
    // ...and the lease is still released, so the session stays reclaimable.
    expect(runner.endPostTurnWork).toHaveBeenCalledTimes(1);
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
