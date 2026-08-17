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
      effectiveMb: 44237,
      autoMb: 44237,
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
  providerRoute: {
    agentId: "claude",
    kind: "account",
    routeId: "acct_1234",
    label: "Work",
  },
  nodeRuntime: {
    state: "provisioned",
    pinSource: ".nvmrc",
    pinRaw: "22",
    resolvedVersion: "22.20.1",
    activeVersion: "22.20.1",
    imageVersion: "24.15.0",
    reason: null,
    mismatch: false,
    composeNodeConflicts: [],
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
    // Auto-derived session memory is shown (44237 MiB on the sample 96 GB host).
    expect(screen.getByText(/44237 MiB — auto/)).toBeTruthy();
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
          autoMb: 44237,
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

  // docs/150-multiple-provider-subscriptions req 11 — after a proactive cutoff or a hard-exhaustion retry has
  // moved a session, this panel is where "which account am I on?" gets
  // answered. The account's NAME is the answer; the opaque id is supporting
  // detail for a bug report, not the thing the user reads.
  it("renders the active provider account by name, with the route id alongside", async () => {
    mockOk(samplePayload);
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText("Provider account")).toBeTruthy();
    });
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText("account / acct_1234")).toBeTruthy();
  });

  it("names a reserved route instead of showing its id", async () => {
    mockOk({
      ...samplePayload,
      providerRoute: {
        agentId: "claude",
        kind: "reserved",
        routeId: "claude-api-key",
        label: "Anthropic API key — metered billing",
      },
    });
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText("Anthropic API key — metered billing")).toBeTruthy();
    });
  });

  it("says a session with no turns yet is not pinned, rather than showing an error", async () => {
    mockOk({
      ...samplePayload,
      providerRoute: {
        agentId: null,
        kind: null,
        routeId: null,
        label: "not pinned yet — the next turn selects an account",
      },
    });
    render(
      <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/not pinned yet/)).toBeTruthy();
    });
  });

  // docs/248 — requirement 6. The reported bug was an INVISIBLE mismatch, so
  // the un-honored states must render their reason, not a terse "ok".
  describe("Node runtime section", () => {
    it("shows the honored pin and the container's own version", async () => {
      mockOk(samplePayload);
      render(
        <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
      );
      await waitFor(() => {
        expect(screen.getByText("Node runtime")).toBeTruthy();
      });
      expect(screen.getByText(/provisioned/)).toBeTruthy();
      // Both the active version and what the pin resolved to render as v22.20.1.
      expect(screen.getAllByText("v22.20.1").length).toBe(2);
      expect(screen.getByText("v24.15.0")).toBeTruthy();
      expect(screen.getByText("22 (.nvmrc)")).toBeTruthy();
    });

    it("surfaces the reason when the pin can't be honored", async () => {
      mockOk({
        ...samplePayload,
        nodeRuntime: {
          state: "failed",
          pinSource: ".nvmrc",
          pinRaw: "22",
          resolvedVersion: null,
          activeVersion: "24.15.0",
          imageVersion: "24.15.0",
          reason: "could not provision Node for `22`: getaddrinfo EAI_AGAIN nodejs.org",
          mismatch: true,
          composeNodeConflicts: [],
        },
      });
      render(
        <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
      );
      await waitFor(() => {
        expect(screen.getByText(/EAI_AGAIN nodejs.org/)).toBeTruthy();
      });
      expect(screen.getByText(/could not provision the pinned Node/)).toBeTruthy();
    });

    it("warns when a Compose service pins a different Node major (requirement 5)", async () => {
      mockOk({
        ...samplePayload,
        nodeRuntime: {
          ...samplePayload.nodeRuntime,
          state: "no-pin",
          pinSource: null,
          pinRaw: null,
          resolvedVersion: null,
          activeVersion: "24.15.0",
          composeNodeConflicts: [{ service: "web", image: "node:22", major: 22 }],
        },
      });
      render(
        <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
      );
      await waitFor(() => {
        expect(screen.getByText(/web \(node:22\)/)).toBeTruthy();
      });
      expect(screen.getByText(/different Node major/)).toBeTruthy();
    });

    it("says so when there is no worker to ask", async () => {
      mockOk({ ...samplePayload, nodeRuntime: null });
      render(
        <SessionDiagnosticsPanel sessionId="sess-1" open={true} onOpenChange={() => {}} />,
      );
      await waitFor(() => {
        expect(screen.getByText(/No running worker to report the Node runtime/)).toBeTruthy();
      });
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
