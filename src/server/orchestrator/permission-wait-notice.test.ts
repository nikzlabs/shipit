import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionRunnerRegistry, type SessionRunnerInterface } from "./session-runner.js";
import { makeDispatchTurnDeps, type FakeAgent } from "./integration_tests/dispatch-test-helpers.js";
import { noteTurnReady } from "./turn-stop-request.js";
import {
  buildPermissionWaitNotice,
  PERMISSION_WAIT_NOTICE_MS,
  PERMISSION_WAIT_RETRY_MS,
  watchPermissionWait,
} from "./permission-wait-notice.js";

describe("watchPermissionWait (docs/193-sensitive-file-permission req 2)", () => {
  let registry: SessionRunnerRegistry;
  let agents: FakeAgent[];
  let steering: boolean;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-12T20:15:35.000Z"));
    agents = [];
    steering = true;
    const { deps } = makeDispatchTurnDeps(agents, []);
    deps.steerInputs = () => ({ liveSteering: steering, steeringCapable: steering });
    registry = new SessionRunnerRegistry({ onRunnerCreated: (runner) => runner.setSystemTurnDeps(deps) });
  });

  afterEach(() => {
    registry.get("s1")?.dispose({ force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function idleRunner(): SessionRunnerInterface {
    return registry.getOrCreate("s1", "/tmp/s1", "claude");
  }

  /** A streaming turn that can take a steer, as `session-inbox.test.ts` builds one. */
  function enterStreamingTurn(runner: SessionRunnerInterface): { sent: string[]; setPermissionMode: ReturnType<typeof vi.fn> } {
    const sent: string[] = [];
    const setPermissionMode = vi.fn();
    runner.setAgent({ sendUserMessage: (text: string) => sent.push(text), setPermissionMode, kill: () => {} } as never);
    runner.running = true;
    noteTurnReady(runner);
    runner.isStreamingActive = true;
    return { sent, setPermissionMode };
  }

  function request(runner: SessionRunnerInterface, requestId: string, summary: string): void {
    runner.awaitingPermissionIds.add(requestId);
    watchPermissionWait(runner, { requestId, summary });
  }

  it("steers one line into the running turn once the request has waited the notice delay", () => {
    const runner = idleRunner();
    const { sent } = enterStreamingTurn(runner);
    request(runner, "perm_1", "Write /workspace/link/a.txt");

    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS - 1);
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(sent).toEqual([
      buildPermissionWaitNotice(
        [{ summary: "Write /workspace/link/a.txt", since: Date.now() - PERMISSION_WAIT_NOTICE_MS }],
        { now: Date.now(), userPresent: false },
      ),
    ]);
    expect(runner.steeredMessages).toMatchObject([{ automatic: true }]);

    vi.advanceTimersByTime(10 * PERMISSION_WAIT_NOTICE_MS);
    expect(sent).toHaveLength(1);
  });

  it("lists every request that waits in one line, when the oldest has waited the delay", () => {
    const runner = idleRunner();
    const { sent } = enterStreamingTurn(runner);
    request(runner, "perm_1", "Write /workspace/link/a.txt");
    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS / 2);
    request(runner, "perm_2", "Bash: cat > link/b.txt <<'EOF'");

    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS / 2);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Write /workspace/link/a.txt");
    expect(sent[0]).toContain("Bash: cat > link/b.txt <<'EOF'");

    vi.advanceTimersByTime(10 * PERMISSION_WAIT_NOTICE_MS);
    expect(sent).toHaveLength(1);
  });

  it("tells a request that comes after a line in a line of its own", () => {
    const runner = idleRunner();
    const { sent } = enterStreamingTurn(runner);
    request(runner, "perm_1", "Write /workspace/link/a.txt");
    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS);
    request(runner, "perm_2", "Write /workspace/link/b.txt");

    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Write /workspace/link/b.txt");
    expect(sent[1]).not.toContain("Write /workspace/link/a.txt");
  });

  it("tries again when the dispatch throws", () => {
    const runner = idleRunner();
    const { sent } = enterStreamingTurn(runner);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(runner, "dispatch").mockImplementationOnce(() => { throw new Error("repository is not trusted"); });
    request(runner, "perm_1", "Write /workspace/link/a.txt");

    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS);
    expect(sent).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PERMISSION_WAIT_RETRY_MS);
    expect(sent).toHaveLength(1);
  });

  it("tells nothing about a request that got its answer before the delay", () => {
    const runner = idleRunner();
    const { sent } = enterStreamingTurn(runner);
    request(runner, "perm_1", "Write /workspace/link/a.txt");

    runner.awaitingPermissionIds.delete("perm_1");
    vi.advanceTimersByTime(10 * PERMISSION_WAIT_NOTICE_MS);

    expect(sent).toEqual([]);
  });

  it("gives a later request its own full delay when the earlier one got its answer", () => {
    const runner = idleRunner();
    const { sent } = enterStreamingTurn(runner);
    request(runner, "perm_1", "Write /workspace/link/a.txt");
    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS / 2);
    request(runner, "perm_2", "Write /workspace/link/b.txt");
    runner.awaitingPermissionIds.delete("perm_1");

    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS / 2);
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS / 2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Write /workspace/link/b.txt");
    expect(sent[0]).not.toContain("Write /workspace/link/a.txt");
  });

  // A new turn can replace the resident process, and the subagents that wait with it.
  it("starts no turn for a session with no running turn, and tells the next turn that runs", () => {
    const runner = idleRunner();
    request(runner, "perm_1", "Write /workspace/link/a.txt");

    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS + 3 * PERMISSION_WAIT_RETRY_MS);
    expect(runner.running).toBe(false);
    expect(agents).toEqual([]);

    const { sent } = enterStreamingTurn(runner);
    vi.advanceTimersByTime(PERMISSION_WAIT_RETRY_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Write /workspace/link/a.txt");
  });

  it("does not queue the line behind a turn that cannot take a steer", () => {
    const runner = idleRunner();
    const { sent } = enterStreamingTurn(runner);
    runner.isStreamingActive = false;
    request(runner, "perm_1", "Write /workspace/link/a.txt");

    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS + PERMISSION_WAIT_RETRY_MS);
    expect(sent).toEqual([]);
    expect(runner.queueLength).toBe(0);

    steering = false;
    runner.isStreamingActive = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.advanceTimersByTime(PERMISSION_WAIT_RETRY_MS);
    expect(sent).toEqual([]);
    expect(runner.queueLength).toBe(0);

    steering = true;
    vi.advanceTimersByTime(PERMISSION_WAIT_RETRY_MS);
    expect(sent).toHaveLength(1);
  });

  it("leaves the running turn's permission mode as it is", () => {
    const runner = idleRunner();
    const { sent, setPermissionMode } = enterStreamingTurn(runner);
    runner.appliedPermissionMode = "plan";
    request(runner, "perm_1", "Write /workspace/link/a.txt");

    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS);

    expect(sent).toHaveLength(1);
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(runner.appliedPermissionMode).toBe("plan");
  });

  it("says whether a user has the session open", () => {
    const runner = idleRunner();
    const { sent } = enterStreamingTurn(runner);
    runner.attachViewer();
    request(runner, "perm_1", "Write /workspace/link/a.txt");

    vi.advanceTimersByTime(PERMISSION_WAIT_NOTICE_MS);

    const waits = [{ summary: "Write /workspace/link/a.txt", since: Date.now() - PERMISSION_WAIT_NOTICE_MS }];
    const present = buildPermissionWaitNotice(waits, { now: Date.now(), userPresent: true });
    expect(sent).toEqual([present]);
    expect(buildPermissionWaitNotice(waits, { now: Date.now(), userPresent: false })).not.toBe(present);
  });

  it("stops when the runner is disposed", () => {
    const runner = idleRunner();
    const { sent } = enterStreamingTurn(runner);
    request(runner, "perm_1", "Write /workspace/link/a.txt");

    runner.dispose({ force: true });
    vi.advanceTimersByTime(10 * PERMISSION_WAIT_NOTICE_MS);

    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("buildPermissionWaitNotice", () => {
  const now = Date.parse("2026-10-12T20:17:35.000Z");

  // /shipit-docs/environment.md and the wiki tell the agent "two minutes".
  it("is sent after the two minutes that the docs name", () => {
    expect(PERMISSION_WAIT_NOTICE_MS).toBe(120_000);
  });

  it("keeps a call's own text inside a code span", () => {
    const text = buildPermissionWaitNotice([{ summary: "Bash: echo `id` > link/f", since: now - 120_000 }], { now, userPresent: false });

    expect(text).toContain("- `Bash: echo 'id' > link/f`");
  });

  it("fills every token, for one call and for several", () => {
    const one = buildPermissionWaitNotice([{ summary: "Write a", since: now - 120_000 }], { now, userPresent: false });
    const two = buildPermissionWaitNotice(
      [{ summary: "Write a", since: now - 300_000 }, { summary: "Bash: b", since: now - 120_000 }],
      { now, userPresent: true },
    );

    for (const text of [one, two]) {
      expect(text.startsWith("[ShipIt]")).toBe(true);
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(text).toContain("- `Write a`");
      expect(text).toContain("2026-10-12T20:17:35.000Z");
    }
    expect(two).toContain("- `Bash: b`");
    expect(one).not.toBe(two);
  });
});
