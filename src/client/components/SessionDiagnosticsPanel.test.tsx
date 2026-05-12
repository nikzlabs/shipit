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
    { type: "log_entry", source: "server", text: "Session container paused after 60s.", timestamp: "2026-05-07T12:00:00.000Z" },
  ],
  parsedConfig: {
    agent: { memory: 3072, cpu: 2.0, pids: 2048, install: ["bash scripts/agent-install.sh"] },
    compose: { file: "docker-compose.yml", dockerSocket: false },
    warnings: [],
    effectiveAgent: { memory: 3072, cpu: 2.0, pids: 2048, dockerAccess: false },
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
    expect(screen.getByText("3072 MiB")).toBeTruthy();
    expect(screen.getByText("bash scripts/agent-install.sh")).toBeTruthy();
    expect(screen.getByText("docker-compose.yml")).toBeTruthy();
  });

  it("surfaces parser warnings for legacy shipit.yaml keys", async () => {
    mockOk({
      ...samplePayload,
      parsedConfig: {
        agent: { memory: 1024, cpu: 0.5, pids: 256, install: [] },
        warnings: ["The `resources` block has been replaced by `agent`."],
        effectiveAgent: { memory: 1024, cpu: 0.5, pids: 256, dockerAccess: false },
      },
    });
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/`resources` block has been replaced/)).toBeTruthy();
    });
    // memory falls through to the library default, which is the value the
    // container actually booted on — visible right next to the warning.
    expect(screen.getByText("1024 MiB")).toBeTruthy();
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
        if (!node || node.tagName !== "P") return false;
        const text = node.textContent ?? "";
        return text.includes("Increase") && text.includes("agent.memory") && text.includes("Rescue session");
      }),
    ).toBeTruthy();
  });

  it("renders declared → effective when an env cap clamps a value", async () => {
    mockOk({
      ...samplePayload,
      parsedConfig: {
        agent: { memory: 3072, cpu: 2.0, pids: 2048, install: [] },
        warnings: ["agent.memory 3072 MiB clamped to 1024 MiB by MAX_SESSION_MEMORY_MB"],
        effectiveAgent: { memory: 1024, cpu: 2.0, pids: 2048, dockerAccess: false },
      },
    });
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/3072 MiB → 1024 MiB \(capped\)/)).toBeTruthy();
    });
    expect(screen.getByText(/MAX_SESSION_MEMORY_MB/)).toBeTruthy();
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
