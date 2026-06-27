import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SessionDiagnosticsPanel } from "./SessionDiagnosticsPanel.js";

// Mock global fetch the panel uses via useApi.
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const samplePayload = {
  sessionId: "sess-1",
  generatedAt: 1_700_000_000_000,
  health: {
    containerState: "running",
    workerReachable: true,
    workerLatencyMs: 8,
    agentRunning: false,
    lastEventAt: 1_699_999_990_000,
    runnerRunningFlag: false,
    viewerCount: 1,
    lastCreateError: null,
    lastCreateErrorAt: null,
    workerUrl: "http://172.18.0.5:8080",
    containerId: "abcdef123456",
  },
  services: [
    {
      name: "web",
      status: "running",
      preview: "auto",
      port: 3000,
      containerIp: "172.18.0.6",
      error: null,
      logTail: "starting on :3000\nready",
    },
    {
      name: "db",
      status: "error",
      preview: "manual",
      port: null,
      containerIp: null,
      error: "Exited with code 137",
      logTail: "out of memory\nkilled",
    },
  ],
  stackStartError: null,
  runner: {
    running: false,
    viewerCount: 1,
    queueLength: 0,
    lastSseEventAt: 1_699_999_990_000,
    turnEventBufferSize: 0,
    disposed: false,
  },
  recentLogs: [
    { source: "server", text: "Session container paused after 60s.", timestamp: "2026-05-07T12:00:00.000Z" },
  ],
  parsedConfig: {
    agent: { install: ["npm install"] },
    compose: { file: "docker-compose.yml", dockerSocket: false },
    warnings: [],
    sizing: {
      effectiveMb: 11059,
      autoMb: 11059,
      hostMb: 98304,
      reserveMb: 9830,
      usableMb: 88474,
      baselineSource: "auto",
      capSource: "host",
      capApplied: false,
    },
  },
  oomBreaker: {
    tripped: false,
    countInWindow: 0,
    lastOomAt: null,
    trippedAt: null,
    threshold: 3,
    windowMs: 5 * 60 * 1000,
  },
};

function mockOk(payload: unknown) {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("SessionDiagnosticsPanel", () => {
  it("renders nothing visible when closed", () => {
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={false} onOpenChange={() => {}} />,
    );
    expect(screen.queryByText("Session diagnostics")).toBeNull();
  });

  it("renders all sections when open with data", async () => {
    mockOk(samplePayload);
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText("Session diagnostics")).toBeTruthy();
      expect(screen.getByText("Container & worker")).toBeTruthy();
    });
    // Health values rendered
    expect(screen.getAllByText("running").length).toBeGreaterThan(0);
    expect(screen.getByText(/yes \(8ms\)/)).toBeTruthy();
    // Compose services rendered (collapsed)
    expect(screen.getByText("web")).toBeTruthy();
    expect(screen.getByText("db")).toBeTruthy();
    // Runner section rendered
    expect(screen.getByText("Runner")).toBeTruthy();
    // Recent logs rendered
    expect(screen.getByText(/Recent logs/)).toBeTruthy();
    expect(screen.getByText(/Session container paused/)).toBeTruthy();
  });

  it("expands a service to show its log tail", async () => {
    mockOk(samplePayload);
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => screen.getByText("web"));
    fireEvent.click(screen.getByText("web"));
    await waitFor(() => {
      expect(screen.getByText(/starting on :3000/)).toBeTruthy();
    });
  });

  it("calls the diagnostics endpoint with the session id", async () => {
    mockOk(samplePayload);
    render(
      <SessionDiagnosticsPanel sessionId="sess-7" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const firstCall = fetchMock.mock.calls[0]?.[0] as string;
    expect(firstCall).toBe("/api/sessions/sess-7/diagnostics");
  });

  it("renders the parsed shipit.yaml values from the payload", async () => {
    mockOk(samplePayload);
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText("Parsed shipit.yaml")).toBeTruthy();
    });
    // Auto-derived session memory is shown (11059 MiB on the sample 96 GB host).
    expect(screen.getByText(/11059 MiB — auto/)).toBeTruthy();
    expect(screen.getByText("npm install")).toBeTruthy();
    expect(screen.getByText("docker-compose.yml")).toBeTruthy();
  });

  it("surfaces parser warnings for legacy shipit.yaml keys", async () => {
    mockOk({
      ...samplePayload,
      parsedConfig: {
        agent: { install: [] },
        warnings: ["The `resources` block has been removed."],
        sizing: samplePayload.parsedConfig.sizing,
      },
    });
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/`resources` block has been removed/)).toBeTruthy();
    });
  });

  it("renders the OOM breaker as tripped with a retry hint", async () => {
    mockOk({
      ...samplePayload,
      oomBreaker: {
        tripped: true,
        countInWindow: 3,
        lastOomAt: 1_700_000_000_000,
        trippedAt: 1_700_000_000_000,
        threshold: 3,
        windowMs: 5 * 60 * 1000,
      },
    });
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/tripped — refusing new containers/)).toBeTruthy();
    });
    // The retry hint paragraph splits its text across <code> + <strong>
    // children, so we match on the combined textContent of the <p>.
    expect(
      screen.getByText((_content, node) => {
        if (node?.tagName !== "P") return false;
        const text = node.textContent ?? "";
        return text.includes("DEFAULT_SESSION_MEMORY_MB") && text.includes("Rescue session");
      }),
    ).toBeTruthy();
  });

  it("renders the cap source when MAX_SESSION_MEMORY_MB clamps the sizing", async () => {
    mockOk({
      ...samplePayload,
      parsedConfig: {
        agent: { install: [] },
        warnings: [],
        sizing: {
          effectiveMb: 1024,
          autoMb: 11059,
          hostMb: 98304,
          reserveMb: 9830,
          usableMb: 88474,
          baselineSource: "auto",
          capSource: "MAX_SESSION_MEMORY_MB",
          capApplied: true,
        },
      },
    });
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/capped to 1024 MiB by MAX_SESSION_MEMORY_MB/)).toBeTruthy();
    });
  });

  it("shows an error message when the endpoint fails", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Failed to load diagnostics/)).toBeTruthy();
    });
  });
});
