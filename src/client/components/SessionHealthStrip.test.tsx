/**
 * Tests for SessionHealthStrip — focused on state preservation across
 * unmount/remount, which is the failure mode that produced the "click
 * Restart agent → switch right-panel tab → come back to 'Container
 * missing' with no overlay, no error, no logs" regression.
 *
 * The right-panel tabs (Preview / Terminal / Docs / Files / History)
 * render via ternary in `App.tsx`, so any tab switch unmounts the
 * Terminal panel and the SessionHealthStrip with it. Anything that
 * lives in React-local `useState` / `useRef` inside the strip is wiped
 * on remount; rescue state has to live in Zustand to survive.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { SessionHealthStrip } from "./SessionHealthStrip.js";
import { useSessionStore } from "../stores/session-store.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // Reset Zustand session store between tests so rescue state from one
  // test doesn't leak into the next.
  useSessionStore.setState({
    rescueState: null,
    recoveryActionError: null,
    interruptError: null,
    pauseNotice: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const healthMissing = {
  containerState: "missing",
  workerReachable: false,
  workerLatencyMs: null,
  agentRunning: null,
  lastEventAt: null,
  runnerRunningFlag: null,
  viewerCount: null,
  lastCreateError: null,
  lastCreateErrorAt: null,
  workerUrl: null,
  containerId: null,
};

const healthRunning = {
  containerState: "running",
  workerReachable: true,
  workerLatencyMs: 8,
  agentRunning: false,
  lastEventAt: Date.now(),
  runnerRunningFlag: false,
  viewerCount: 1,
  lastCreateError: null,
  lastCreateErrorAt: null,
  workerUrl: "http://172.18.0.5:8080",
  containerId: "abcdef123456",
};

/** Queue a sequence of fetch responses (each consumed by one fetch call). */
function queueResponses(responses: { status?: number; body: unknown }[]) {
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
}

/** Default catch-all so unconsumed polls don't return undefined. */
function defaultPolls(body: unknown = healthMissing) {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("SessionHealthStrip", () => {
  describe("state preservation across unmount/remount (tab switch)", () => {
    it("preserves the rescue overlay when the strip is unmounted+remounted mid-restart", async () => {
      // Seed Zustand as if the user had just clicked Restart agent: the strip
      // sets `rescueState` with `startedAt` before the POST resolves. We
      // simulate the in-flight state directly rather than driving it through
      // the button so the test isn't sensitive to fetch ordering.
      const startedAt = Date.now();
      useSessionStore.getState().setRescueState({
        phase: "restarting_agent",
        startedAt,
      });

      defaultPolls(healthMissing);

      // First mount — strip should see the in-flight rescue state and render
      // the "Restarting agent…" label rather than the bare "Container missing"
      // diagnostic.
      const { unmount } = render(
        <SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />,
      );
      await waitFor(() => {
        expect(screen.getByText("Restarting agent…")).toBeTruthy();
      });

      // Tab switch: unmount the strip (simulating App.tsx's ternary swap to
      // a different right-panel tab) and immediately remount it.
      unmount();

      // CRITICAL: the unmount must NOT have wiped rescueState. Before the
      // fix this assertion failed — the mount-time useEffect that's meant
      // to clear state on session change was firing on every mount and
      // calling setRescueState(null) unconditionally.
      expect(useSessionStore.getState().rescueState).not.toBeNull();
      expect(useSessionStore.getState().rescueState?.phase).toBe("restarting_agent");
      expect(useSessionStore.getState().rescueState?.startedAt).toBe(startedAt);

      // Remount — fresh React-local state, but Zustand is preserved so the
      // "Restarting agent…" overlay should still render.
      render(<SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />);
      await waitFor(() => {
        expect(screen.getByText("Restarting agent…")).toBeTruthy();
      });
    });

    it("preserves recoveryActionError across unmount/remount", async () => {
      useSessionStore.getState().setRecoveryActionError("Restart agent failed: Docker daemon unreachable");
      defaultPolls(healthMissing);

      const { unmount } = render(
        <SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />,
      );
      await waitFor(() => {
        expect(screen.getByText(/Docker daemon unreachable/)).toBeTruthy();
      });

      unmount();
      expect(useSessionStore.getState().recoveryActionError).toBe(
        "Restart agent failed: Docker daemon unreachable",
      );

      render(<SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />);
      await waitFor(() => {
        expect(screen.getByText(/Docker daemon unreachable/)).toBeTruthy();
      });
    });

    it("DOES clear rescue state when the sessionId actually changes", async () => {
      useSessionStore.getState().setRescueState({
        phase: "restarting_agent",
        startedAt: Date.now(),
      });
      useSessionStore.getState().setRecoveryActionError("stale error from prev session");
      defaultPolls(healthMissing);

      const { rerender } = render(
        <SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />,
      );

      // Switch to a different session — this should fire the reset useEffect.
      rerender(<SessionHealthStrip sessionId="sess-2" onReconnectWs={() => {}} />);

      await waitFor(() => {
        expect(useSessionStore.getState().rescueState).toBeNull();
        expect(useSessionStore.getState().recoveryActionError).toBeNull();
      });
    });
  });

  describe("polling-driven overlay finalization", () => {
    it("transitions rescueState to 'ready' when container becomes running mid-restart", async () => {
      const startedAt = Date.now();
      useSessionStore.getState().setRescueState({
        phase: "creating_container",
        startedAt,
      });

      // First poll returns healthy. The strip should clear the rescue state.
      defaultPolls(healthRunning);

      render(<SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />);

      await waitFor(() => {
        expect(useSessionStore.getState().rescueState?.phase).toBe("ready");
      });
    });

    it("transitions to 'failed' when a fresh lastCreateError lands after the rescue started", async () => {
      const startedAt = Date.now() - 5000;
      useSessionStore.getState().setRescueState({
        phase: "creating_container",
        startedAt,
      });

      defaultPolls({
        ...healthMissing,
        lastCreateError: "Container ran out of memory",
        lastCreateErrorAt: startedAt + 2000, // after the rescue click
      });

      render(<SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />);

      await waitFor(() => {
        const rs = useSessionStore.getState().rescueState;
        expect(rs?.phase).toBe("failed");
        expect(rs?.message).toBe("Container ran out of memory");
      });
    });

    it("ignores a stale lastCreateError older than the current rescue's startedAt", async () => {
      const startedAt = Date.now();
      useSessionStore.getState().setRescueState({
        phase: "creating_container",
        startedAt,
      });

      // Create error is OLDER than the rescue click — should be ignored.
      defaultPolls({
        ...healthMissing,
        lastCreateError: "old error from prior attempt",
        lastCreateErrorAt: startedAt - 10000,
      });

      render(<SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />);

      // Wait one poll cycle, then assert phase didn't flip to "failed".
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(useSessionStore.getState().rescueState?.phase).toBe("creating_container");
    });
  });

  describe("button click sets rescueState with startedAt", () => {
    it("sets rescueState with startedAt when Restart agent is clicked", async () => {
      // First call: GET /container/health → missing
      // Second call: POST /agent/container/restart → starting
      queueResponses([
        { body: healthMissing },
        {
          body: {
            ok: true,
            noContainer: false,
            newContainerState: "starting",
            error: null,
          },
        },
      ]);
      defaultPolls(healthMissing); // subsequent polls

      render(<SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />);

      // Wait for initial health to land so the strip is in its idle state.
      await waitFor(() => {
        // The "Container missing" badge is visible.
        const matches = screen.getAllByText(/Container missing/i);
        expect(matches.length).toBeGreaterThan(0);
      });

      const restartButton = screen.getByRole("button", { name: /Restart agent/i });
      fireEvent.click(restartButton);

      await waitFor(() => {
        const rs = useSessionStore.getState().rescueState;
        expect(rs).not.toBeNull();
        expect(rs?.startedAt).toBeTypeOf("number");
        expect(rs!.startedAt!).toBeGreaterThan(0);
      });
    });
  });
});
