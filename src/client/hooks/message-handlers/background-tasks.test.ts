import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleBackgroundTasks, backgroundTaskLabel } from "./background-tasks.js";
import { handleSessionStatus } from "./session-status.js";
import type { HandlerContext } from "./types.js";
import type { WsBackgroundTasks, WsSessionStatus } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const tasks = (over: Partial<WsBackgroundTasks> = {}): WsBackgroundTasks => ({
  type: "background_tasks",
  sessionId: "s1",
  count: 1,
  descriptions: ["npm test"],
  ...over,
});

const status = (over: Partial<WsSessionStatus> = {}): WsSessionStatus => ({
  type: "session_status",
  sessionId: "s1",
  running: false,
  ...over,
});

beforeEach(() => {
  useSessionStore.setState({
    sessionId: "s1",
    activeRunnerSessions: new Set<string>(),
    backgroundTaskSessions: new Map<string, string[]>(),
    isLoading: false,
    activity: undefined,
  });
});

/**
 * docs/235 — a turn can end with background work still outstanding. The session
 * is not idle then: it will wake itself when the task finishes, so the UI has to
 * keep saying something is happening.
 */
describe("handleBackgroundTasks (docs/235)", () => {
  it("marks the session as holding background tasks", () => {
    handleBackgroundTasks(ctx, tasks());
    expect(useSessionStore.getState().backgroundTaskSessions.has("s1")).toBe(true);
  });

  it("clears the marker when the backend reports a drained list", () => {
    handleBackgroundTasks(ctx, tasks());
    handleBackgroundTasks(ctx, tasks({ count: 0, descriptions: [] }));
    expect(useSessionStore.getState().backgroundTaskSessions.has("s1")).toBe(false);
  });

  it("keeps the status bar up with a naming label while a task is pending", () => {
    handleBackgroundTasks(ctx, tasks());
    const s = useSessionStore.getState();
    expect(s.isLoading).toBe(true);
    expect(s.activity).toEqual({ label: "Waiting for: npm test" });
  });

  it("leaves `tool` unset so the tool spinner doesn't imply a live tool call", () => {
    handleBackgroundTasks(ctx, tasks());
    expect(useSessionStore.getState().activity?.tool).toBeUndefined();
  });

  it("clears the status bar once no tasks remain and no turn is running", () => {
    handleBackgroundTasks(ctx, tasks());
    handleBackgroundTasks(ctx, tasks({ count: 0, descriptions: [] }));

    const s = useSessionStore.getState();
    expect(s.isLoading).toBe(false);
    expect(s.activity).toBeUndefined();
  });

  /**
   * The two axes stay separate: `activeRunnerSessions` means "a turn is in
   * flight" and gates PR actions. It must be untouched in BOTH directions —
   * pending work must not widen it, and a drain must not clear it. The drain
   * landing ~1ms before the CLI's self-wake is exactly the regression that made
   * a running session read as idle.
   */
  it("never touches the running-runner set", () => {
    handleBackgroundTasks(ctx, tasks());
    expect(useSessionStore.getState().activeRunnerSessions.has("s1")).toBe(false);

    useSessionStore.setState({ activeRunnerSessions: new Set(["s1"]) });
    handleBackgroundTasks(ctx, tasks({ count: 0, descriptions: [] }));
    expect(useSessionStore.getState().activeRunnerSessions.has("s1")).toBe(true);
  });

  /**
   * Mid-turn the turn owns the chat surfaces. A background job starting must not
   * replace the live tool label, and one draining must not clear the spinner.
   */
  it("leaves the chat surfaces alone while a turn is running", () => {
    useSessionStore.setState({
      activeRunnerSessions: new Set(["s1"]),
      isLoading: true,
      activity: { label: "Thinking...", tool: "Bash" },
    });

    handleBackgroundTasks(ctx, tasks());
    expect(useSessionStore.getState().activity).toEqual({ label: "Thinking...", tool: "Bash" });

    handleBackgroundTasks(ctx, tasks({ count: 0, descriptions: [] }));
    const s = useSessionStore.getState();
    expect(s.isLoading).toBe(true);
    expect(s.activity).toEqual({ label: "Thinking...", tool: "Bash" });
  });

  it("tracks background tasks for a session that is not the active one", () => {
    handleBackgroundTasks(ctx, tasks({ sessionId: "other", count: 2, descriptions: ["a", "b"] }));
    const s = useSessionStore.getState();
    expect(s.backgroundTaskSessions.has("other")).toBe(true);
    // The chat surfaces belong to the active session only.
    expect(s.isLoading).toBe(false);
    expect(s.activity).toBeUndefined();
  });
});

/**
 * The turn-end `session_status` says nothing about background work, so it reads
 * the standing marker from the store. Without that, a turn that ended with a job
 * still running would clear the indicator and look finished.
 */
describe("handleSessionStatus — standing background work", () => {
  it("keeps the status bar up, named, when a turn ends with a task outstanding", () => {
    useSessionStore.setState({ activeRunnerSessions: new Set(["s1"]) });
    handleBackgroundTasks(ctx, tasks());
    handleSessionStatus(ctx, status({ running: false }));

    const s = useSessionStore.getState();
    expect(s.backgroundTaskSessions.has("s1")).toBe(true);
    expect(s.isLoading).toBe(true);
    expect(s.activity).toEqual({ label: "Waiting for: npm test" });
  });

  it("clears the status bar when a turn ends with nothing outstanding", () => {
    useSessionStore.setState({ activeRunnerSessions: new Set(["s1"]), isLoading: true });
    handleSessionStatus(ctx, status({ running: false }));

    const s = useSessionStore.getState();
    expect(s.isLoading).toBe(false);
    expect(s.activity).toBeUndefined();
  });

  it("falls back to the unnamed label when only the reconnect snapshot is known", () => {
    // The SSE `session_attention` snapshot carries ids without descriptions.
    useSessionStore.setState({ backgroundTaskSessions: new Map([["s1", []]]) });
    handleSessionStatus(ctx, status({ running: false }));

    expect(useSessionStore.getState().activity)
      .toEqual({ label: "Waiting for a background task to finish" });
  });
});

describe("backgroundTaskLabel", () => {
  it("names the task when there is exactly one", () => {
    expect(backgroundTaskLabel(["npm test"])).toBe("Waiting for: npm test");
  });

  it("counts instead of listing when there are several", () => {
    expect(backgroundTaskLabel(["a", "b", "c"])).toBe("Waiting for 3 background tasks to finish");
  });

  it("falls back to a generic label with no descriptions", () => {
    expect(backgroundTaskLabel([])).toBe("Waiting for a background task to finish");
  });

  it("truncates a long command so the status line can't grow unbounded", () => {
    const long = "x".repeat(100);
    const label = backgroundTaskLabel([long]);
    expect(label.length).toBeLessThan(80);
    expect(label.endsWith("…")).toBe(true);
  });

  it("ignores a blank description rather than rendering an empty name", () => {
    expect(backgroundTaskLabel(["   "])).toBe("Waiting for a background task to finish");
  });
});
