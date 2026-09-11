

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { SessionHealthStrip } from "./SessionHealthStrip.js";
import { useSessionStore } from "../../stores/session-store.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);

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

      // the button so the test isn't sensitive to fetch ordering.
      const startedAt = Date.now();
      useSessionStore.getState().setRescueState({
        phase: "restarting_agent",
        startedAt,
      });

      defaultPolls(healthMissing);

      const { unmount } = render(
        <SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />,
      );
      await waitFor(() => {
        expect(screen.getByText("Restarting agent…")).toBeTruthy();
      });

      unmount();

      // CRITICAL: the unmount must NOT have wiped rescueState. Before the

      expect(useSessionStore.getState().rescueState).not.toBeNull();
      expect(useSessionStore.getState().rescueState?.phase).toBe("restarting_agent");
      expect(useSessionStore.getState().rescueState?.startedAt).toBe(startedAt);

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
        lastCreateErrorAt: startedAt + 2000,                          
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

      defaultPolls({
        ...healthMissing,
        lastCreateError: "old error from prior attempt",
        lastCreateErrorAt: startedAt - 10000,
      });

      render(<SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />);

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(useSessionStore.getState().rescueState?.phase).toBe("creating_container");
    });
  });

  describe("a long creation error cannot squeeze out the log view", () => {
    it("bounds the error box's height and scrolls the overflow", async () => {
      defaultPolls({
        ...healthMissing,
        lastCreateError: "OCI runtime create failed: no such file or directory\n".repeat(24),
        lastCreateErrorAt: Date.now(),
      });

      render(<SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />);

      const box = await screen.findByRole("group", { name: "Container creation error detail" });
      expect(box).toHaveClass("max-h-20", "overflow-y-auto");

      expect(box).toHaveAttribute("tabindex", "0");
    });

    it("bounds the expanded details block, which carries the unbounded poll error", async () => {
      fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 172.18.0.5:8080 ".repeat(20)));

      render(<SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: /details/i }));

      const details = screen.getByRole("group", { name: "Session health details" });
      expect(details).toHaveClass("max-h-48", "overflow-y-auto");
      expect(details).toHaveAttribute("tabindex", "0");
    });
  });

  describe("button click sets rescueState with startedAt", () => {
    it("sets rescueState with startedAt when Restart agent is clicked", async () => {

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
      defaultPolls(healthMissing);                    

      render(<SessionHealthStrip sessionId="sess-1" onReconnectWs={() => {}} />);

      await waitFor(() => {

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
