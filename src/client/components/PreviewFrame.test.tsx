import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreviewFrame, formatErrorForMessage, type PreviewStatus } from "./PreviewFrame.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { findPresetById } from "./device-presets.js";
import type { PreviewError } from "../hooks/usePreviewErrors.js";

// jsdom doesn't implement ResizeObserver — provide a no-op stub for the device-frame measurement effect.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// Mock fetch so the URL-reachability poll resolves immediately in tests
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  usePreviewStore.getState().reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const defaultProps = {
  detectedPorts: [] as number[],
  selectedPort: null as number | null,
  onSelectPort: vi.fn(),
  errors: [] as PreviewError[],
  onSendErrors: vi.fn(),
  onClearErrors: vi.fn(),
};

function makeError(overrides: Partial<PreviewError> = {}): PreviewError {
  return {
    id: "pe-1",
    type: "error",
    message: "Uncaught TypeError: x is not a function",
    timestamp: "2025-01-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("PreviewFrame", () => {
  it("shows nothing when preview is null and no session", () => {
    render(<PreviewFrame preview={null} {...defaultProps} />);
    // No overlay content — empty preview area
    expect(screen.queryByText(/Preview will appear here/)).not.toBeInTheDocument();
  });

  it("shows spinner when preview is null but session is active", () => {
    render(<PreviewFrame preview={null} sessionId="abc-123" {...defaultProps} />);
    expect(screen.getByText("Starting dev server...")).toBeInTheDocument();
  });

  it("shows startup steps with fetch running when initialized", () => {
    usePreviewStore.getState().initStartupSteps();
    render(<PreviewFrame preview={null} {...defaultProps} />);
    expect(screen.getByText(/Fetching latest changes/)).toBeInTheDocument();
    expect(screen.getByText("Installing dependencies")).toBeInTheDocument();
    expect(screen.getByText("Starting dev server")).toBeInTheDocument();
  });

  it("shows fetch duration after completing", () => {
    usePreviewStore.getState().initStartupSteps();
    usePreviewStore.getState().setStartupStep({ stepId: "fetch", status: "complete", durationMs: 1200 });
    render(<PreviewFrame preview={null} {...defaultProps} />);
    expect(screen.getByText("(1.2s)")).toBeInTheDocument();
  });

  it("renders iframe when preview is running", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute("src", "http://localhost:5173");
  });

  it("shows service name for detected source when service is known", () => {
    usePreviewStore.getState().setServices([{ name: "web", status: "running", port: 3001, preview: "auto" }]);
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected" };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001]} selectedPort={null} onSelectPort={vi.fn()} />);
    expect(screen.getByText("web")).toBeInTheDocument();
  });

  it("shows port text without selector when only one detected port", () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected" };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001]} selectedPort={null} onSelectPort={vi.fn()} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText(/localhost:3001/)).toBeInTheDocument();
  });

  it("shows dropdown selector when multiple detected ports exist", () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001, 8080]} selectedPort={null} onSelectPort={vi.fn()} />);
    const trigger = screen.getByLabelText("Select preview port");
    expect(trigger).toBeInTheDocument();
    expect(trigger.tagName).toBe("BUTTON");
  });

  it("shows dropdown when Vite is running and detected ports also exist", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite", detectedPorts: [3001] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001]} selectedPort={null} onSelectPort={vi.fn()} />);
    const trigger = screen.getByLabelText("Select preview port");
    expect(trigger).toBeInTheDocument();
  });

  it("lists Vite port and detected ports in the selector", async () => {
    const user = userEvent.setup();
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001, 8080]} selectedPort={null} onSelectPort={vi.fn()} />);
    // Open the dropdown
    await user.click(screen.getByLabelText("Select preview port"));
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Vite");
    expect(items[1]).toHaveTextContent("port 3001");
    expect(items[2]).toHaveTextContent("port 8080");
  });

  it("calls onSelectPort when user clicks a dropdown item", async () => {
    const user = userEvent.setup();
    const onSelectPort = vi.fn();
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001, 8080]} selectedPort={null} onSelectPort={onSelectPort} />);
    // Open the dropdown
    await user.click(screen.getByLabelText("Select preview port"));
    // Click the second port option
    const items = screen.getAllByRole("menuitem");
    await user.click(items[1]);
    expect(onSelectPort).toHaveBeenCalledWith(8080);
  });

  it("uses selectedPort for the iframe when provided", async () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001, 8080]} selectedPort={8080} onSelectPort={vi.fn()} />);
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:8080");
  });

  it("falls back to preview.port when selectedPort is null", async () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected" };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001]} selectedPort={null} onSelectPort={vi.fn()} />);
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:3001");
  });

  it("increments refresh key when Reload is clicked", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    await screen.findByTitle("Live Preview");

    fireEvent.click(screen.getByTitle("Refresh preview"));
    // iframe should have been re-mounted (different React key forces remount)
    await screen.findByTitle("Live Preview");
  });

  it("selector label matches selectedPort", () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001, 8080]} selectedPort={8080} onSelectPort={vi.fn()} />);
    const trigger = screen.getByLabelText("Select preview port");
    expect(trigger).toHaveTextContent("localhost:8080");
  });

  // ---- Error badge & panel tests ----

  it("shows error badge when there are errors", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const errors = [makeError()];
    render(<PreviewFrame preview={preview} {...defaultProps} errors={errors} />);
    expect(screen.getByLabelText("Toggle error panel")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("does not show error badge when there are no errors", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    expect(screen.queryByLabelText("Toggle error panel")).not.toBeInTheDocument();
  });

  it("toggles error panel when badge is clicked", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const errors = [makeError()];
    render(<PreviewFrame preview={preview} {...defaultProps} errors={errors} />);

    // Panel should not be visible initially
    expect(screen.queryByRole("region", { name: "Preview errors" })).not.toBeInTheDocument();

    // Click to open
    fireEvent.click(screen.getByLabelText("Toggle error panel"));
    expect(screen.getByRole("region", { name: "Preview errors" })).toBeInTheDocument();
    expect(screen.getByText("Uncaught TypeError: x is not a function")).toBeInTheDocument();

    // Click to close
    fireEvent.click(screen.getByLabelText("Toggle error panel"));
    expect(screen.queryByRole("region", { name: "Preview errors" })).not.toBeInTheDocument();
  });

  it("calls onSendErrors when 'Send to Agent' is clicked", () => {
    const onSendErrors = vi.fn();
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const errors = [makeError()];
    render(<PreviewFrame preview={preview} {...defaultProps} errors={errors} onSendErrors={onSendErrors} />);

    fireEvent.click(screen.getByLabelText("Toggle error panel"));
    fireEvent.click(screen.getByText("Send to Agent"));
    expect(onSendErrors).toHaveBeenCalledWith(errors);
  });

  it("calls onSendErrors for a single error when Fix button is clicked", () => {
    const onSendErrors = vi.fn();
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const errors = [makeError({ id: "pe-1" }), makeError({ id: "pe-2", message: "Second error" })];
    render(<PreviewFrame preview={preview} {...defaultProps} errors={errors} onSendErrors={onSendErrors} />);

    fireEvent.click(screen.getByLabelText("Toggle error panel"));
    const fixButtons = screen.getAllByTitle("Send this error to the agent");
    fireEvent.click(fixButtons[0]);
    expect(onSendErrors).toHaveBeenCalledWith([errors[0]]);
  });

  it("calls onClearErrors when Clear button in error panel is clicked", () => {
    const onClearErrors = vi.fn();
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const errors = [makeError()];
    render(<PreviewFrame preview={preview} {...defaultProps} errors={errors} onClearErrors={onClearErrors} />);

    fireEvent.click(screen.getByLabelText("Toggle error panel"));
    fireEvent.click(screen.getByTitle("Clear all errors"));
    expect(onClearErrors).toHaveBeenCalled();
  });

  it("shows auto-fix toggle", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    expect(screen.getByText("Auto-fix")).toBeInTheDocument();
  });

  it("toggles autoFix in store when toggle is clicked", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    expect(usePreviewStore.getState().autoFixEnabled).toBe(false);
    fireEvent.click(screen.getByText("Auto-fix"));
    expect(usePreviewStore.getState().autoFixEnabled).toBe(true);
  });

  it("shows retry count when auto-fix is active with retries", () => {
    usePreviewStore.setState({ autoFixEnabled: true, autoFixRetries: 2 });
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    expect(screen.getByText("Auto-fix (2/3)")).toBeInTheDocument();
  });

  it("shows error count badge capped at 99+", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const errors = Array.from({ length: 100 }, (_, i) => makeError({ id: `pe-${i}`, message: `Error ${i}` }));
    render(<PreviewFrame preview={preview} {...defaultProps} errors={errors} />);
    expect(screen.getByText("99+")).toBeInTheDocument();
  });

  it("shows stack trace in error details", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const errors = [makeError({ stack: "Error: x\n  at foo.js:10\n  at bar.js:20" })];
    render(<PreviewFrame preview={preview} {...defaultProps} errors={errors} />);

    fireEvent.click(screen.getByLabelText("Toggle error panel"));
    expect(screen.getByText("Stack trace")).toBeInTheDocument();
  });

  it("shows console warn errors with [warn] prefix", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const errors = [makeError({ type: "console", level: "warn", message: "Deprecation warning" })];
    render(<PreviewFrame preview={preview} {...defaultProps} errors={errors} />);

    fireEvent.click(screen.getByLabelText("Toggle error panel"));
    expect(screen.getByText("[warn]")).toBeInTheDocument();
    expect(screen.getByText("Deprecation warning")).toBeInTheDocument();
  });

  // ---- Install status tests (via startup steps) ----

  it("shows install running state via startup steps", () => {
    usePreviewStore.getState().initStartupSteps();
    usePreviewStore.getState().setStartupStep({ stepId: "install", status: "running" });
    render(<PreviewFrame preview={null} {...defaultProps} />);
    expect(screen.getByText(/Installing dependencies/)).toBeInTheDocument();
  });

  it("shows install error state with message via startup steps", () => {
    usePreviewStore.getState().initStartupSteps();
    usePreviewStore.getState().setStartupStep({ stepId: "install", status: "error", message: "exit code 1" });
    render(<PreviewFrame preview={null} {...defaultProps} />);
    expect(screen.getByText(/exit code 1/)).toBeInTheDocument();
  });

  // ---- Compose error overlay tests ----

  it("shows compose error overlay when composeError is set", () => {
    usePreviewStore.getState().setComposeError("Service `dev`: Absolute bind mount path `/app/node_modules` is not allowed.");
    render(<PreviewFrame preview={null} {...defaultProps} />);
    expect(screen.getByText("Docker Compose error")).toBeInTheDocument();
    expect(screen.getByText(/Absolute bind mount/)).toBeInTheDocument();
  });

  it("shows Send to agent button in compose error overlay", () => {
    usePreviewStore.getState().setComposeError("some error");
    const onSendCrashToAgent = vi.fn();
    render(<PreviewFrame preview={null} {...defaultProps} onSendCrashToAgent={onSendCrashToAgent} />);
    const btn = screen.getByText("Send to agent");
    fireEvent.click(btn);
    expect(onSendCrashToAgent).toHaveBeenCalled();
  });

  it("clears compose error when services arrive", () => {
    usePreviewStore.getState().setComposeError("old error");
    usePreviewStore.getState().setServices([{ name: "web", status: "running", port: 5173, preview: "auto" }]);
    expect(usePreviewStore.getState().composeError).toBeNull();
  });

  // ---- Compose not configured hint tests ----

  it("shows compose hint when composeNotConfigured is set", () => {
    usePreviewStore.getState().setComposeNotConfigured(true);
    render(<PreviewFrame preview={null} {...defaultProps} />);
    expect(screen.getByText(/shipit\.yaml/)).toBeInTheDocument();
    expect(screen.getByText(/to enable previews/)).toBeInTheDocument();
  });

  it("shows Send to agent button in compose hint overlay", () => {
    usePreviewStore.getState().setComposeNotConfigured(true);
    const onSendComposeHintToAgent = vi.fn();
    render(<PreviewFrame preview={null} {...defaultProps} onSendComposeHintToAgent={onSendComposeHintToAgent} />);
    const btn = screen.getByText("Send to agent");
    fireEvent.click(btn);
    expect(onSendComposeHintToAgent).toHaveBeenCalled();
  });

  it("clears composeNotConfigured when services arrive", () => {
    usePreviewStore.getState().setComposeNotConfigured(true);
    usePreviewStore.getState().setServices([{ name: "web", status: "running", port: 5173, preview: "auto" }]);
    expect(usePreviewStore.getState().composeNotConfigured).toBe(false);
  });

  // ---- Manual-only inline service list (dogfooding case) ----

  it("renders inline ServiceList with Start button when every service is manual", () => {
    usePreviewStore.getState().setServices([
      { name: "dev", status: "stopped", port: 3000, preview: "manual" },
    ]);
    const onStartService = vi.fn();
    // A non-null preview with running:false is what the orchestrator emits
    // once the compose stack is up but no service is running — same shape
    // as the "No preview running" empty state the user sees in production.
    const stoppedPreview: PreviewStatus = { running: false, port: 0, url: "" };
    render(
      <PreviewFrame
        preview={stoppedPreview}
        sessionId="abc"
        {...defaultProps}
        onStartService={onStartService}
        onStopService={vi.fn()}
      />,
    );
    // Inline list is shown instead of the "View service logs" empty state
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.queryByText("View service logs")).not.toBeInTheDocument();
    // Clicking the Start affordance dispatches start_service
    fireEvent.click(screen.getByTitle("Start dev"));
    expect(onStartService).toHaveBeenCalledWith("dev");
  });

  it("falls back to the View-service-logs overlay when at least one service is auto", () => {
    usePreviewStore.getState().setServices([
      { name: "web", status: "stopped", port: 5173, preview: "auto" },
      { name: "dev", status: "stopped", port: 3000, preview: "manual" },
    ]);
    const stoppedPreview: PreviewStatus = { running: false, port: 0, url: "" };
    render(
      <PreviewFrame
        preview={stoppedPreview}
        sessionId="abc"
        {...defaultProps}
        onStartService={vi.fn()}
        onStopService={vi.fn()}
      />,
    );
    // Mixed stack: keep the existing empty state — auto preview is expected
    // to come up on its own and the inline list would be noise.
    expect(screen.getByText("View service logs")).toBeInTheDocument();
    // The auto service name shouldn't appear as a list row
    expect(screen.queryByTitle("Start web")).not.toBeInTheDocument();
  });

  it("renders the iframe when preview.running flips true while a manual service is in services", async () => {
    // This is the dogfooding pivot: after the user clicks Start on the
    // manual `dev` service, App.tsx synthesizes a `running:true` preview
    // status (via deriveEffectivePreviewStatus) and passes it here. The
    // services list still contains the running service, but the manual-only
    // overlay must NOT show — the iframe should take over instead.
    usePreviewStore.getState().setServices([
      { name: "dev", status: "running", port: 3000, preview: "manual" },
    ]);
    // Container-mode poll hits /api/preview-health/.../{port} and waits for
    // `{ ready: true }`. Override the default fetch stub for this test.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ready: true }), { status: 200 })),
    );
    const runningPreview: PreviewStatus = {
      running: true,
      port: 3000,
      url: "/preview/abc/3000/",
      source: "detected",
      detectedPorts: [3000],
    };
    render(
      <PreviewFrame
        preview={runningPreview}
        sessionId="abc"
        {...defaultProps}
        detectedPorts={[3000]}
        onStartService={vi.fn()}
        onStopService={vi.fn()}
      />,
    );
    // The manual-only overlay must not show — the iframe takes its place.
    expect(screen.queryByText("No preview running. Start a service to launch it.")).not.toBeInTheDocument();
    // The iframe poll completes via the stubbed fetch; iframe then mounts.
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe).toBeInTheDocument();
  });

  it("shows 'Connecting to dev server...' (not 'Starting dev server...') while polling a running preview", () => {
    // Dogfooding regression: when the orchestrator has reported the preview as
    // running but the iframe slot hasn't been polled into existence yet, the
    // overlay used to say "Starting dev server..." — confusing in dogfooding
    // because the user already started the service and Vite logs "ready in
    // 437ms" while the spinner is on screen. The wording now reflects
    // reality: the dev server is up, we're connecting to it.
    usePreviewStore.getState().setServices([
      { name: "dev", status: "running", port: 3000, preview: "manual" },
    ]);
    // Never resolve — keep the poll pending so the overlay stays visible.
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const runningPreview: PreviewStatus = {
      running: true,
      port: 3000,
      url: "/preview/abc/3000/",
      source: "detected",
      detectedPorts: [3000],
    };
    render(
      <PreviewFrame
        preview={runningPreview}
        sessionId="abc"
        {...defaultProps}
        detectedPorts={[3000]}
      />,
    );
    expect(screen.getByText("Connecting to dev server...")).toBeInTheDocument();
    // The legacy wording must NOT appear in this state — it's reserved for
    // the path-1 spinner (no preview, no startup steps).
    expect(screen.queryByText("Starting dev server...")).not.toBeInTheDocument();
  });

  it("creates iframe slot promptly when preview-health flips to ready after a few polls (dogfood slow boot)", async () => {
    // Dogfooding case: the dev container is reported `running` by docker
    // compose but Vite isn't actually serving on :3000 yet, so preview-health
    // returns `{ ready: false }` for the first few polls. As soon as Vite
    // comes up and preview-health flips to `{ ready: true }`, the iframe
    // slot must be created — otherwise the user is stuck looking at the
    // "Connecting to dev server..." overlay long after Vite logged
    // "ready in 437 ms".
    usePreviewStore.getState().setServices([
      { name: "dev", status: "running", port: 3000, preview: "manual" },
    ]);
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount += 1;
        // First few polls: dev container is up but Vite isn't listening yet.
        // Then Vite comes up and the probe succeeds.
        const ready = callCount > 3;
        return Promise.resolve(
          new Response(JSON.stringify({ ready }), { status: 200 }),
        );
      }),
    );
    const runningPreview: PreviewStatus = {
      running: true,
      port: 3000,
      url: "/preview/abc/3000/",
      source: "detected",
      detectedPorts: [3000],
    };
    render(
      <PreviewFrame
        preview={runningPreview}
        sessionId="abc"
        {...defaultProps}
        detectedPorts={[3000]}
      />,
    );
    // The poll loop awaits fetch() with a 250ms gap between iterations —
    // findByTitle's default 1000ms timeout is comfortably enough for 4 polls.
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe).toBeInTheDocument();
    // The fetch should have been called at least 4 times before flipping to ready.
    expect(callCount).toBeGreaterThanOrEqual(4);
  });

  // ---- Managed source tests ----

  it("renders iframe for managed source preview", async () => {
    const preview: PreviewStatus = { running: true, port: 3000, url: "http://localhost:3000", source: "managed" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:3000");
  });

  it("shows Preview label in port selector for managed source", async () => {
    const user = userEvent.setup();
    const preview: PreviewStatus = { running: true, port: 3000, url: "http://localhost:3000", source: "managed", detectedPorts: [8080] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[8080]} selectedPort={null} onSelectPort={vi.fn()} />);
    // Open the dropdown
    await user.click(screen.getByLabelText("Select preview port"));
    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("Preview");
  });

  // ---- Stale iframe tests ----

  it("preserves session A iframe in pool while polling for session B", async () => {
    const previewA: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { rerender } = render(<PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />);
    // Wait for iframe to become ready (fetch mock resolves immediately)
    await screen.findByTitle("Live Preview");
    expect(screen.getByTitle("Live Preview")).toHaveAttribute("src", "http://localhost:5173");

    // Switch to session B with a different running preview — polling hasn't resolved yet
    // Use a fetch that never resolves to simulate polling delay
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const previewB: PreviewStatus = { running: true, port: 3000, url: "http://localhost:3000", source: "vite" };
    rerender(<PreviewFrame preview={previewB} sessionId="session-b" {...defaultProps} />);

    // Session A's iframe is preserved in pool as a background preview
    const iframe = screen.getByTitle("Background Preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:5173");
  });

  it("preserves session A iframe in pool during session switch with null preview", async () => {
    const previewA: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { rerender } = render(<PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />);
    await screen.findByTitle("Live Preview");

    // Switch to session B where preview is null (waiting for WS message)
    rerender(<PreviewFrame preview={null} sessionId="session-b" {...defaultProps} />);

    // Session A's iframe is preserved in pool as a background preview
    const iframe = screen.getByTitle("Background Preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:5173");
  });

  it("shows spinner for fresh session start (no stale iframe)", () => {
    // No previous preview → stale ref is null → show spinner
    render(<PreviewFrame preview={null} sessionId="session-a" {...defaultProps} />);
    expect(screen.getByText("Starting dev server...")).toBeInTheDocument();
    expect(screen.queryByTitle("Live Preview")).not.toBeInTheDocument();
  });

  // ---- Device frame / mobile preview tests ----

  it("does not render device selector when preview is not running", () => {
    render(<PreviewFrame preview={null} sessionId="session-a" {...defaultProps} />);
    expect(screen.queryByLabelText("Select device viewport")).not.toBeInTheDocument();
  });

  it("renders device selector when preview is running", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    expect(screen.getByLabelText("Select device viewport")).toBeInTheDocument();
  });

  it("applies explicit width/height to the iframe when a preset is active", async () => {
    const preset = findPresetById("iphone-14")!;
    usePreviewStore.setState({ devicePreset: preset, isLandscape: false, customSize: null });
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe.style.width).toBe("390px");
    expect(iframe.style.height).toBe("844px");
  });

  it("swaps width and height when isLandscape is true", async () => {
    const preset = findPresetById("iphone-14")!;
    usePreviewStore.setState({ devicePreset: preset, isLandscape: true, customSize: null });
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe.style.width).toBe("844px");
    expect(iframe.style.height).toBe("390px");
  });

  it("shows dimension label when a preset is active", async () => {
    const preset = findPresetById("iphone-14")!;
    usePreviewStore.setState({ devicePreset: preset, isLandscape: false, customSize: null });
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    expect(screen.getByText(/390×844/)).toBeInTheDocument();
  });

  it("does not show dimension label when responsive is active", () => {
    usePreviewStore.setState({ devicePreset: null, isLandscape: false, customSize: null });
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    expect(screen.queryByText(/×\d+/)).not.toBeInTheDocument();
  });

  it("does not constrain iframe size when no preset is active", async () => {
    usePreviewStore.setState({ devicePreset: null, isLandscape: false, customSize: null });
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = await screen.findByTitle("Live Preview");
    // No inline width/height when responsive
    expect(iframe.style.width).toBe("");
    expect(iframe.style.height).toBe("");
  });

  it("setDevicePreset updates store state", () => {
    const preset = findPresetById("ipad-mini")!;
    usePreviewStore.getState().setDevicePreset(preset);
    expect(usePreviewStore.getState().devicePreset?.id).toBe("ipad-mini");
    usePreviewStore.getState().setDevicePreset(null);
    expect(usePreviewStore.getState().devicePreset).toBeNull();
  });

  it("toggleLandscape flips the isLandscape flag", () => {
    expect(usePreviewStore.getState().isLandscape).toBe(false);
    usePreviewStore.getState().toggleLandscape();
    expect(usePreviewStore.getState().isLandscape).toBe(true);
    usePreviewStore.getState().toggleLandscape();
    expect(usePreviewStore.getState().isLandscape).toBe(false);
  });

  it("scales the iframe down when the container is smaller than the device", async () => {
    // Mock HTMLDivElement clientWidth/clientHeight so the device-frame measurement
    // sees a 400×400 panel. iPad Air is 820×1180, so scale should be < 1.
    const widthSpy = vi.spyOn(HTMLDivElement.prototype, "clientWidth", "get").mockReturnValue(400);
    const heightSpy = vi.spyOn(HTMLDivElement.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      const preset = findPresetById("ipad-air")!;
      usePreviewStore.setState({ devicePreset: preset, isLandscape: false, customSize: null });
      const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
      render(<PreviewFrame preview={preview} {...defaultProps} />);
      const iframe = await screen.findByTitle("Live Preview");
      // Expected scale: min(1, (400-32)/820, (400-32)/1180) = 368/1180 ≈ 0.312
      const transform = iframe.style.transform;
      const match = /scale\(([^)]+)\)/.exec(transform);
      expect(match).not.toBeNull();
      const scale = Number(match![1]);
      expect(scale).toBeGreaterThan(0);
      expect(scale).toBeLessThan(1);
      // Header should show the scaled-down percentage
      const expectedPercent = Math.round(Math.min(1, 368 / 820, 368 / 1180) * 100);
      expect(screen.getByText(new RegExp(`\\(${expectedPercent}%\\)`))).toBeInTheDocument();
    } finally {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
  });

  it("does not scale below 1.0 when container is larger than device", async () => {
    const widthSpy = vi.spyOn(HTMLDivElement.prototype, "clientWidth", "get").mockReturnValue(2000);
    const heightSpy = vi.spyOn(HTMLDivElement.prototype, "clientHeight", "get").mockReturnValue(2000);
    try {
      const preset = findPresetById("iphone-se")!;
      usePreviewStore.setState({ devicePreset: preset, isLandscape: false, customSize: null });
      const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
      render(<PreviewFrame preview={preview} {...defaultProps} />);
      const iframe = await screen.findByTitle("Live Preview");
      const match = /scale\(([^)]+)\)/.exec(iframe.style.transform);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBe(1);
      // No "(NN%)" indicator when scale is 1
      expect(screen.queryByText(/\(\d+%\)/)).not.toBeInTheDocument();
    } finally {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
  });

  // ---- Phase 5: missing-secrets banner ----

  it("shows missing-secrets banner when missingRequired is non-empty", () => {
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "DATABASE_URL", required: true, services: ["api"] }],
      missingByService: { api: ["DATABASE_URL"] },
      missingRequired: ["DATABASE_URL"],
    });
    render(<PreviewFrame preview={null} {...defaultProps} />);
    expect(screen.getByTestId("secrets-missing-banner")).toBeInTheDocument();
    expect(screen.getByTestId("secrets-missing-banner")).toHaveTextContent("DATABASE_URL is required");
  });

  it("hides missing-secrets banner when no required secrets are missing", () => {
    usePreviewStore.getState().setSecrets({
      declared: [],
      missingByService: {},
      missingRequired: [],
    });
    render(<PreviewFrame preview={null} {...defaultProps} />);
    expect(screen.queryByTestId("secrets-missing-banner")).not.toBeInTheDocument();
  });

  it("pluralizes the banner message when multiple required secrets are missing", () => {
    usePreviewStore.getState().setSecrets({
      declared: [],
      missingByService: {},
      missingRequired: ["A", "B", "C"],
    });
    render(<PreviewFrame preview={null} {...defaultProps} />);
    expect(screen.getByTestId("secrets-missing-banner")).toHaveTextContent("3 required secrets are missing");
  });

  it("Configure button opens the Settings → Secrets tab", async () => {
    const { useUiStore } = await import("../stores/ui-store.js");
    usePreviewStore.getState().setSecrets({
      declared: [],
      missingByService: {},
      missingRequired: ["DATABASE_URL"],
    });
    render(<PreviewFrame preview={null} {...defaultProps} />);
    await userEvent.click(screen.getByTestId("secrets-missing-configure"));
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsTab).toBe("secrets");
  });
});

describe("formatErrorForMessage", () => {
  it("formats errors into an agent-friendly prompt", () => {
    const errors: PreviewError[] = [
      makeError({ message: "TypeError: x is not a function", source: "http://localhost:5173/src/main.tsx", line: 10, col: 5 }),
    ];
    const result = formatErrorForMessage(errors);
    expect(result).toContain("preview is showing these errors");
    expect(result).toContain("TypeError: x is not a function");
    expect(result).toContain("main.tsx:10:5");
    expect(result).toContain("Please fix these errors");
  });

  it("includes stack trace first line when no source/line", () => {
    const errors: PreviewError[] = [
      makeError({ message: "ReferenceError: foo is not defined", stack: "ReferenceError: foo\n  at Module.foo (app.js:42:10)" }),
    ];
    const result = formatErrorForMessage(errors);
    expect(result).toContain("at Module.foo (app.js:42:10)");
  });

  it("formats multiple errors with numbering", () => {
    const errors: PreviewError[] = [
      makeError({ id: "pe-1", message: "Error 1" }),
      makeError({ id: "pe-2", message: "Error 2" }),
    ];
    const result = formatErrorForMessage(errors);
    expect(result).toContain("1. Error 1");
    expect(result).toContain("2. Error 2");
  });
});
