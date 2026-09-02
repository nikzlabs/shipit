import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAutoPushScheduler,
  MAX_PUSH_DEFERRALS,
  PUSH_DEFER_RETRY_MS,
  type AutoPushDeps,
} from "./auto-push-scheduler.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionRunnerInterface } from "../session-runner.js";
// The ops-safe table is the CONSUMER of the lines this module writes, so the
// tests below check the real predicate rather than a copy of the wording: a
// producer that drifts off its template stops crossing the session boundary,
// and that is exactly the failure these assertions have to catch.
import { isOpsSafeLine } from "./host-session-logs.js";

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
    // The default workspace is not mid-rewrite, so a rejection here is a real
    // divergence and takes the loud path.
    isRebaseInProgress: vi.fn(async () => false),
    // The reads `services/push-divergence.ts` makes at a rejection. Supplied
    // even on the happy-path fake: the measurement never throws, so a fake
    // missing them degrades every notice to "could not be measured" and the
    // shape assertions below would pass for the wrong reason.
    currentBranchOrNull: vi.fn(async () => "shipit/feature"),
    fetchBranch: vi.fn(async () => {}),
    // The default is the rewritten-branch shape — commits on BOTH sides. A
    // rejected push cannot have `behind: 0`: that would mean the remote is an
    // ancestor of HEAD, i.e. a plain push fast-forwards.
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

/**
 * A push that fails the way a diverged branch fails. `counts` is the shape the
 * rejection-time measurement finds; the default (1 here, 0 there) is the
 * ordinary rewritten-branch case.
 */
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

  it("says on the log ring that the push LANDED, in counts only (docs/264)", async () => {
    // The ops read (`services/host-session-logs.ts`) could see four auto-push
    // FAILURE lines and no success, so silence across a session's window meant
    // "pushed fine" or "nothing to push" or "failed with no template" or "aged
    // out of the ring". This line is the positive confirmation that separates
    // them — and it carries no branch, no remote and no git output, which is
    // what lets it cross the session boundary at all.
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(fakeGit({ aheadBehind: vi.fn(async () => ({ ahead: 3, behind: 0 })) }), "s1");

    await fireDebounce();

    const lines = deps.broadcastLog.mock.calls.filter((c) => c[1] === "server").map((c) => c[2] as string);
    const completed = lines.filter((t) => t.startsWith("Auto-push completed"));
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatch(/^Auto-push completed in \d+ms: 3 commit\(s\) pushed\.$/);
    expect(completed[0]).not.toContain("shipit/feature");
    expect(isOpsSafeLine(completed[0])).toBe(true);
  });

  it("distinguishes a turn that pushed nothing from a push that failed", async () => {
    // Most of the value of the success line: a run of these says the turns
    // produced no commits, which is a completely different diagnosis from a run
    // of rejections — and previously both looked like silence.
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(fakeGit({ aheadBehind: vi.fn(async () => ({ ahead: 0, behind: 0 })) }), "s1");

    await fireDebounce();

    const line = deps.broadcastLog.mock.calls.map((c) => c[2] as string)
      .find((t) => t.startsWith("Auto-push completed"));
    expect(line).toContain("nothing new to push");
    expect(isOpsSafeLine(line ?? "")).toBe(true);
  });

  it("reports an unmeasurable count as unmeasured, never as zero commits", async () => {
    // A branch with no upstream yet — the first push of a session. Claiming
    // "0 commit(s) pushed" there is the misreport class this module exists for.
    const deps = makeDeps();
    createAutoPushScheduler(deps).schedule(fakeGit({ aheadBehind: vi.fn(async () => null) }), "s1");

    await fireDebounce();

    const line = deps.broadcastLog.mock.calls.map((c) => c[2] as string)
      .find((t) => t.startsWith("Auto-push completed"));
    expect(line).toContain("the commit count could not be measured");
    expect(isOpsSafeLine(line ?? "")).toBe(true);
  });

  it("splits a push failure into ShipIt's class and git's own words", async () => {
    // The producer split the ops-safe table asks for: the class is authored and
    // crosses the session boundary; git's text is on its own line and does not.
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
    // Exactly one line crosses the boundary, and it is the one naming the class.
    expect(opsSafe).toHaveLength(1);
    expect(opsSafe[0]).toMatch(/^Auto-push failed \([a-z-]+\)\. /);
    expect(opsSafe[0]).not.toContain("/workspace/secret");
    // The detail is still there for the session's OWN Logs panel.
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

  it("releases the lease on the runner that took it when the runner is replaced before the push fires", async () => {
    // planning#424. The release used to re-resolve the runner by session id, so
    // a runner disposed and rebuilt while a push was armed received a release
    // for a lease it never took — its own post-turn hold went short and the
    // enforcer could reclaim it mid-push — while the predecessor's hold leaked.
    // The lease must unwind on the ORIGINAL object: the disposed predecessor's
    // counter returns to zero (harmless, nobody consults it), and the
    // successor's hold is untouched.
    const original = fakeRunner();
    const successor = fakeRunner();
    let current: SessionRunnerInterface | null = original;
    const deps = makeDeps({ getRunner: () => current });
    const git = fakeGit();
    createAutoPushScheduler(deps).schedule(git, "s1");
    expect(original.beginPostTurnWork).toHaveBeenCalledTimes(1);

    // A forced disposal or a crash-rebuild swaps the session's runner while
    // the push is armed.
    current = successor;

    await fireDebounce();

    expect(original.endPostTurnWork).toHaveBeenCalledTimes(1);
    expect(successor.endPostTurnWork).not.toHaveBeenCalled();
    // The push itself is host-side git and must not care about the swap.
    expect(git.push).toHaveBeenCalledTimes(1);
  });

  it("releases the original runner's lease when the pending push is cancelled after a runner replacement", () => {
    // The public `cancel` (a synchronous push already shipped the work) drops
    // the armed timer. Its release must land on the runner that took the lease,
    // not on the successor that happens to exist now.
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
    // Re-arming (`schedule` once per turn, or the retry chain) drops the
    // pending timer and arms a fresh one. Each lease is released on the object
    // it was taken on: the superseded hold unwinds the ORIGINAL runner, and the
    // replacement hold protects the CURRENT one — never the other way around.
    const original = fakeRunner();
    const successor = fakeRunner();
    let current: SessionRunnerInterface | null = original;
    const deps = makeDeps({ getRunner: () => current });
    const git = fakeGit();
    const scheduler = createAutoPushScheduler(deps);
    scheduler.schedule(git, "s1");
    current = successor;
    scheduler.schedule(git, "s1"); // superseded before it fired

    expect(original.beginPostTurnWork).toHaveBeenCalledTimes(1);
    expect(original.endPostTurnWork).toHaveBeenCalledTimes(1);
    expect(successor.beginPostTurnWork).toHaveBeenCalledTimes(1);
    expect(successor.endPostTurnWork).not.toHaveBeenCalled();

    await fireDebounce();

    expect(original.endPostTurnWork).toHaveBeenCalledTimes(1); // exactly once
    expect(successor.endPostTurnWork).toHaveBeenCalledTimes(1);
    expect(git.push).toHaveBeenCalledTimes(1);
  });

  it("keeps each runner's lease balanced when a deferred push retries across a runner replacement", async () => {
    // The retry chain (a rebase in flight) re-arms at PUSH_DEFER_RETRY_MS. The
    // re-arm resolves the runner fresh, so across a replacement the first hold
    // unwinds the original and the retry holds the successor — both exactly
    // balanced, so neither runner ends up under-held for its own push.
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

    await fireDebounce(); // deferred mid-rebase; the retry is now armed
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
    // `cancelAll` is the one timer-drop path with no replacement: at shutdown
    // no synchronous push has landed, and the process exits with the commit
    // local. That is exactly the "path that ends without a push" the module
    // refuses to go silent about — one line per dropped push.
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
    // …and how do I ship it. The remedy has to be a command the agent can run.
    expect(notice).toContain("git pull --rebase origin shipit/feature");
    expect(deps.chatHistory.append).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ notice: true, noticeLevel: "warn" }),
    );
  });

  it("measures the shape at the rejection and names the recovery that fits it", async () => {
    // The 2026-08-30 incident: nothing unpushed here, one already-published
    // commit only on the REMOTE, dropped locally by an agent-side rebase. The
    // fixed three-case notice this replaces asserted the opposite (the commit is
    // safe locally, further commits stay local) and emphasised
    // `reset-to-base --force`, which would have deleted it.
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
    // `block-branch-ops.mjs` refuses a hand-rolled force-push while the session
    // carries a recorded `mergedHeadSha`. A remedy the agent is refused when it
    // runs it is a dead end it only discovers by being refused.
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
    // The banner is not a passive warning: its "Update branch" button rebases
    // onto the base and force-pushes (`services/rebase-driver.ts`). In the
    // 2026-08-30 shape — nothing unpushed here, the remote holding the one
    // commit — that is one click from deleting it. Arming it used to be
    // unconditional, which left the wrong recommendation this fix removes from
    // the notice available as a button.
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    createAutoPushScheduler(deps).schedule(divergedGit({ ahead: 0, behind: 1 }), "s1");

    await fireDebounce();

    const rejected = runner.emitMessage.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((m) => m.type === "git_push_rejected");
    expect(rejected).toHaveLength(0);
    // …and the durable explanation still lands. Withholding the button must not
    // cost the notice that says what to do instead.
    expect(appendedNotices(deps)[0]).toContain("git pull --rebase origin shipit/feature");
  });

  it("still arms the rebase banner for the rewritten branch it repairs", async () => {
    // Commits on both sides: the branch was rewritten and never republished, so
    // the banner's force-push is the remedy rather than the hazard. This is the
    // 2026-08-15 shape the banner was built for.
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    createAutoPushScheduler(deps).schedule(divergedGit({ ahead: 2, behind: 1 }), "s1");

    await fireDebounce();

    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "git_push_rejected", reason: "non_fast_forward" }),
    );
  });

  it("withholds the rebase banner when the shape could not be measured", async () => {
    // Fails closed. Withholding a button costs a click; arming it on a shape
    // nobody measured costs the commit.
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
    // Counts only, no branch or remote name — that is what lets this line be an
    // ops-safe template (`services/host-session-logs.ts`), so an ops session
    // diagnosing this incident can read which side is at risk.
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
    // Every measurement read is best-effort. A second failure must degrade the
    // explanation, never replace it with silence — and it must not let the
    // notice guess a recovery, because the two destroy opposite sides.
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
    // If the episode flag never cleared, a LATER divergence would be suppressed
    // for the life of the session — the original bug, back again.
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

  it("ends the episode when a synchronous gh-pr-create push replaces the debounced one", async () => {
    // `agentCreatePr` force-pushes past a merged PR and then calls `cancel` to
    // drop the now-redundant debounce (`dropPendingAutoPush`). That force-push
    // is what HEALS the divergence in practice — it is how the incident's branch
    // recovered twice — so the episode has to end there too. Clearing only on an
    // auto-push success suppresses the next genuine divergence indefinitely.
    const deps = makeDeps();
    const scheduler = createAutoPushScheduler(deps);

    scheduler.schedule(divergedGit(), "s1");
    await fireDebounce();
    expect(appendedNotices(deps)).toHaveLength(1);

    scheduler.cancel("s1"); // the synchronous push landed

    scheduler.schedule(divergedGit(), "s1");
    await fireDebounce();
    expect(appendedNotices(deps)).toHaveLength(2);
  });

  it("does not end the episode merely because the next turn re-arms the push", async () => {
    // `schedule` replaces a pending push by dropping its timer. That must not go
    // through the public `cancel`, or the dedup collapses to nothing and every
    // commit gets an identical notice.
    const deps = makeDeps();
    const git = divergedGit();
    const scheduler = createAutoPushScheduler(deps);

    scheduler.schedule(git, "s1");
    scheduler.schedule(git, "s1"); // re-armed before the first fired
    await fireDebounce();
    scheduler.schedule(git, "s1");
    await fireDebounce();

    expect(appendedNotices(deps)).toHaveLength(1);
  });

  it("persists the notice even when the log ring and the viewer transport both throw", async () => {
    // The divergence path reports BEFORE it persists. Unisolated, a throwing log
    // ring aborted the branch before the notice — losing the durable record on
    // exactly the sessions whose other surfaces are already unhealthy.
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
      // A real rejection, marker and all. The bare summary line
      // ("failed to push some refs") deliberately no longer classifies as a
      // divergence — see `classifyPushFailure`.
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

/**
 * The 2026-08-17 incident (session 590c19aa): a turn's commit armed this push,
 * the auto-conflict-resolve path started a rebase 1.2s later, and the push fired
 * 4s into it. It was rejected non-fast-forward — because our own `git rebase`
 * had just rewritten local history — and the user got the full "your branch has
 * diverged … a pull request on it would merge WITHOUT this commit" notice, with
 * recovery commands, for a branch the rebase driver force-pushed 23 seconds
 * later. Nothing was wrong and nothing needed them.
 */
describe("auto-push scheduler — a rejection explained by our own rebase is not a divergence", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** Mid-rebase on the first check, settled by the time the retry fires. */
  function rebasingThenHealedGit(): GitManager {
    let probes = 0;
    return fakeGit({
      isRebaseInProgress: vi.fn(async () => { probes++; return probes === 1; }),
    });
  }

  it("does not even attempt the push while a rebase is in flight", async () => {
    // Mid-rebase the workspace is on a detached HEAD, so `getCurrentBranch()`
    // returns the literal "HEAD" and `git push origin HEAD` is refused by git
    // with a message ending in "failed to push some refs" — which
    // `isNonFastForwardError` matches. That is how a push that never reached
    // the remote came to be reported as a diverged branch.
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
    // The half only the runner's flag can see: `git rebase --continue` has
    // finished, so git reports no rebase, but the driver has not force-pushed
    // the rewritten history yet. A genuine non-fast-forward, and still ours.
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
    // The asymmetry that keeps the generic flag safe: CI auto-fix, wake turns
    // and prepared dispatch hold `systemTurnInProgress` too, and none of them
    // rewrite history. The flag is consulted only after a push has already
    // failed, so a healthy push during a long system turn still lands.
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

    // Silence is the failure mode this module exists to prevent — a quieter
    // wording is fine, no line at all is not.
    expect(warn.mock.calls.some((c) => String(c[0]).includes("deferred"))).toBe(true);
    expect(deps.broadcastLog).toHaveBeenCalledWith("s1", "server", expect.stringContaining("deferred"));
  });

  it("retries the deferred push, so the commit still reaches origin", async () => {
    // Deferring, not dropping, is what covers the rebase-ABORT path: an abort
    // restores the pre-rebase branch and pushes nothing, so this commit would
    // otherwise sit local with nothing left to publish it.
    const deps = makeDeps();
    const git = rebasingThenHealedGit();
    createAutoPushScheduler(deps).schedule(git, "s1");

    await fireDebounce();
    expect(git.push).not.toHaveBeenCalled(); // held back mid-rebase

    await vi.advanceTimersByTimeAsync(PUSH_DEFER_RETRY_MS);
    await vi.waitFor(() => {});

    expect(git.push).toHaveBeenCalledTimes(1);
    expect(appendedNotices(deps)).toHaveLength(0);
    expect(deps.notifyAutoPush).toHaveBeenCalledWith("s1"); // the retry landed
  });

  it("keeps the post-turn lease balanced across a deferral and its retry", async () => {
    // The lease is what stops the idle enforcer destroying the container out
    // from under a commit that has landed but not been pushed. A re-arm takes a
    // fresh hold while the firing timer's `finally` releases the old one, so the
    // two must stay in step — a chain of retries must not under- or over-hold.
    const runner = fakeRunner();
    const deps = makeDeps({ getRunner: () => runner });
    createAutoPushScheduler(deps).schedule(rebasingThenHealedGit(), "s1");

    await fireDebounce();
    // Mid-chain: one more begin than end, i.e. the pending retry still holds.
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
    // 30 deferrals at 30s each, then the push is attempted and its rejection
    // reported — rather than letting a wedged signal suppress a real divergence
    // for the session's lifetime. The budget is shared by both checks, so a
    // spent cap cannot be refilled by handing the push to the other one.
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
    // Fails toward visible: "cannot tell" must not become "nothing to see".
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
