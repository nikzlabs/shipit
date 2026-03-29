import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PreviewFrame, formatErrorForMessage, type PreviewStatus } from "./PreviewFrame.js";
import { usePreviewStore } from "../stores/preview-store.js";
import type { PreviewError } from "../hooks/usePreviewErrors.js";

// Mock fetch so the URL-reachability poll resolves immediately in tests
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
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

  it("shows (auto-detected) label for detected source with single port", () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected" };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001]} selectedPort={null} onSelectPort={vi.fn()} />);
    expect(screen.getByText("(auto-detected)")).toBeInTheDocument();
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
    const select = screen.getByLabelText("Select preview port");
    expect(select).toBeInTheDocument();
    expect(select.tagName).toBe("SELECT");
  });

  it("shows dropdown when Vite is running and detected ports also exist", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite", detectedPorts: [3001] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001]} selectedPort={null} onSelectPort={vi.fn()} />);
    const select = screen.getByLabelText("Select preview port");
    expect(select).toBeInTheDocument();
  });

  it("lists Vite port and detected ports in the selector", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001, 8080]} selectedPort={null} onSelectPort={vi.fn()} />);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent("5173 (Vite)");
    expect(options[1]).toHaveTextContent("3001");
    expect(options[2]).toHaveTextContent("8080");
  });

  it("calls onSelectPort when user changes the dropdown", () => {
    const onSelectPort = vi.fn();
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001, 8080]} selectedPort={null} onSelectPort={onSelectPort} />);
    const select = screen.getByLabelText("Select preview port");
    fireEvent.change(select, { target: { value: "8080" } });
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

  it("selector value matches selectedPort", () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001, 8080]} selectedPort={8080} onSelectPort={vi.fn()} />);
    const select = screen.getByLabelText("Select preview port") as HTMLSelectElement;
    expect(select.value).toBe("8080");
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

  // ---- Managed source tests ----

  it("renders iframe for managed source preview", async () => {
    const preview: PreviewStatus = { running: true, port: 3000, url: "http://localhost:3000", source: "managed" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:3000");
  });

  it("shows Preview label in port selector for managed source", () => {
    const preview: PreviewStatus = { running: true, port: 3000, url: "http://localhost:3000", source: "managed", detectedPorts: [8080] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[8080]} selectedPort={null} onSelectPort={vi.fn()} />);
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("3000 (Preview)");
  });

  // ---- Stale iframe tests ----

  it("shows stale iframe while polling for new session's preview", async () => {
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

    // Stale iframe from session A should still be visible
    const iframe = screen.getByTitle("Live Preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:5173");
  });

  it("shows stale iframe during session switch even when preview is null", async () => {
    const previewA: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { rerender } = render(<PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />);
    await screen.findByTitle("Live Preview");

    // Switch to session B where preview is null (waiting for WS message)
    rerender(<PreviewFrame preview={null} sessionId="session-b" {...defaultProps} />);

    // Stale iframe should be visible — dev server is already running, just waiting for WS
    const iframe = screen.getByTitle("Live Preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:5173");
    expect(screen.queryByText("Starting dev server...")).not.toBeInTheDocument();
  });

  it("shows spinner for fresh session start (no stale iframe)", () => {
    // No previous preview → stale ref is null → show spinner
    render(<PreviewFrame preview={null} sessionId="session-a" {...defaultProps} />);
    expect(screen.getByText("Starting dev server...")).toBeInTheDocument();
    expect(screen.queryByTitle("Live Preview")).not.toBeInTheDocument();
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
