import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSessionStatus, backgroundTaskLabel } from "./session-status.js";
import type { HandlerContext } from "./types.js";
import type { WsSessionStatus } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

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
    backgroundTaskSessions: new Set<string>(),
    isLoading: false,
    activity: undefined,
  });
});

/**
 * docs/235 — a turn can end with background work still outstanding. The session
 * is not idle then: it will wake itself when the task finishes, so the UI has to
 * keep saying something is happening.
 */
describe("handleSessionStatus — background tasks (docs/235)", () => {
  it("marks the session as holding background tasks", () => {
    handleSessionStatus(ctx, status({ backgroundTasks: { count: 1, descriptions: ["npm test"] } }));
    expect(useSessionStore.getState().backgroundTaskSessions.has("s1")).toBe(true);
  });

  it("clears the marker when the backend reports a drained list", () => {
    handleSessionStatus(ctx, status({ backgroundTasks: { count: 1, descriptions: ["npm test"] } }));
    handleSessionStatus(ctx, status({ backgroundTasks: { count: 0, descriptions: [] } }));
    expect(useSessionStore.getState().backgroundTaskSessions.has("s1")).toBe(false);
  });

  it("keeps the status bar up with a naming label while a task is pending", () => {
    handleSessionStatus(ctx, status({ backgroundTasks: { count: 1, descriptions: ["npm test"] } }));
    const s = useSessionStore.getState();
    expect(s.isLoading).toBe(true);
    expect(s.activity).toEqual({ label: "Waiting for: npm test" });
  });

  it("leaves `tool` unset so the tool spinner doesn't imply a live tool call", () => {
    handleSessionStatus(ctx, status({ backgroundTasks: { count: 1, descriptions: ["npm test"] } }));
    expect(useSessionStore.getState().activity?.tool).toBeUndefined();
  });

  // The turn-end `session_status` emitted by `agent_result` carries no
  // `backgroundTasks` field. Without the store fallback it would clear the
  // indicator and the session would look finished while work is still running.
  it("survives a turn-end status that omits the backgroundTasks field", () => {
    handleSessionStatus(ctx, status({ running: true, backgroundTasks: { count: 1, descriptions: ["npm test"] } }));
    handleSessionStatus(ctx, status({ running: false }));

    const s = useSessionStore.getState();
    expect(s.backgroundTaskSessions.has("s1")).toBe(true);
    expect(s.isLoading).toBe(true);
    expect(s.activity?.label).toBe("Waiting for a background task to finish");
  });

  it("clears the status bar once no tasks remain and no turn is running", () => {
    handleSessionStatus(ctx, status({ backgroundTasks: { count: 1, descriptions: ["npm test"] } }));
    handleSessionStatus(ctx, status({ backgroundTasks: { count: 0, descriptions: [] } }));

    const s = useSessionStore.getState();
    expect(s.isLoading).toBe(false);
    expect(s.activity).toBeUndefined();
  });

  it("does not touch the running-runner set (the two axes stay separate)", () => {
    // `activeRunnerSessions` means "a turn is in flight" and gates PR actions;
    // pending background work must not widen it.
    handleSessionStatus(ctx, status({ backgroundTasks: { count: 1, descriptions: ["npm test"] } }));
    expect(useSessionStore.getState().activeRunnerSessions.has("s1")).toBe(false);
  });

  it("tracks background tasks for a session that is not the active one", () => {
    handleSessionStatus(ctx, status({
      sessionId: "other",
      backgroundTasks: { count: 2, descriptions: ["a", "b"] },
    }));
    const s = useSessionStore.getState();
    expect(s.backgroundTaskSessions.has("other")).toBe(true);
    // The chat surfaces belong to the active session only.
    expect(s.isLoading).toBe(false);
    expect(s.activity).toBeUndefined();
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
