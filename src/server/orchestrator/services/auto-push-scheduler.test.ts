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

interface AppendedRow { notice?: boolean; noticeLevel?: string; text?: string }

type TestDeps = AutoPushDeps & {
  broadcastLog: ReturnType<typeof vi.fn>;
  notifyAutoPush: ReturnType<typeof vi.fn>;
  chatHistory: { append: ReturnType<typeof vi.fn> };
  /** Rows that actually LANDED in history — an append that throws adds nothing. */
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

/** The persisted notices this scheduler appended, newest last. */
function appendedNotices(deps: TestDeps): string[] {
  return deps.appended.filter((m) => m.notice).map((m) => m.text ?? "");
}

/** A push that fails the way a diverged branch fails. */
function divergedGit(): GitManager {
  return fakeGit({
    push: vi.fn(async () => {
      throw new Error(
        "Updates were rejected because the tip of your current branch is behind (non-fast-forward)",
      );
    }),
  });
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

  it("puts every no-push path on the server log, not just in the session's log ring", async () => {
    // `broadcastLog` writes ONLY to the durable log store and the in-memory
    // ring; it makes no console call. So `docker logs` showed a commit line and
    // then nothing, which reads as a push that succeeded — the reason ten hours
    // of rejected pushes went undetected on 2026-08-14/15.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({ getRunner: () => null });
    createAutoPushScheduler(deps).schedule(divergedGit(), "s1");

    await fireDebounce();

    const warned = warn.mock.calls.flat().join(" ");
    expect(warned).toContain("s1");
    expect(warned).toContain("diverged");
  });

  it("names WHICH condition made pushToOrigin skip — no origin, or no branch", async () => {
    // The module's last fully silent exit: both null returns landed on a bare
    // `if (!branch) return;` and said nothing on any surface.
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

/**
 * The 2026-08-15 incident. A branch was rebased onto a fresh base after a merge
 * — the flow ShipIt's own agent instructions prescribe — so the unforced
 * post-turn push was rejected on every turn for ten hours. Nine commits stayed
 * local; two pull requests then merged at the state of the last SUCCESSFUL push,
 * seven and two commits behind. The rejection reached only the log ring (a panel
 * nobody had open) and a transient WS message, so neither the user nor the agent
 * ever learned the branch had stopped shipping.
 *
 * These assert the OUTCOME — a durable line in the transcript saying what
 * happened, why, and how to ship it — never the call shape.
 */
describe("auto-push scheduler — a rejected push leaves a transcript notice", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("persists a notice that names the branch, the reason, and the remedy", async () => {
    // Fails without the fix: before it, the ONLY durable record was a log-ring
    // line, and chat history recorded nothing at all.
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(divergedGit(), "s1");

    await fireDebounce();

    const notices = appendedNotices(deps);
    expect(notices).toHaveLength(1);
    const notice = notices[0];
    // What happened to my commit…
    expect(notice).toContain("Not pushed");
    expect(notice).toContain("shipit/feature");
    // …why…
    expect(notice).toContain("non-fast-forward");
    expect(notice).toContain("WITHOUT this commit");
    // …and how do I ship it. The remedy has to be a command the agent can run.
    expect(notice).toContain("git pull --rebase origin shipit/feature");
    expect(notice).toContain("git push --force-with-lease origin shipit/feature");
    // planning#267 arms a hook that BLOCKS the force-push on a merged branch —
    // the state this notice routinely fires in — so the sanctioned command for
    // that case has to be named too, or the remedy is a dead end.
    expect(notice).toContain("shipit branch reset-to-base");
    expect(deps.chatHistory.append).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ notice: true, noticeLevel: "warn" }),
    );
  });

  it("persists the notice even when the session has no runner left to emit to", async () => {
    // The push fires from a debounce AFTER the turn ended, so the runner may
    // already be gone. The append is the half that has to survive that.
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
    // Nine identical notices is noise that trains the reader to skip the tenth.
    // Every rejection still reaches the log ring; only the transcript is deduped.
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
    // `gh pr create` force-pushes and heals the divergence on its own path. If
    // the episode flag never cleared, a LATER divergence would be suppressed for
    // the life of the session — the original bug, back again.
    const deps = makeDeps();
    const scheduler = createAutoPushScheduler(deps);

    scheduler.schedule(divergedGit(), "s1");
    await fireDebounce();
    expect(appendedNotices(deps)).toHaveLength(1);

    scheduler.schedule(fakeGit(), "s1"); // healed — this push lands
    await fireDebounce();

    scheduler.schedule(divergedGit(), "s1");
    await fireDebounce();
    expect(appendedNotices(deps)).toHaveLength(2);
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

    // The failed attempt must not leave the episode marked as notified.
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
      push: vi.fn(async () => { throw new Error("failed to push some refs"); }),
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
