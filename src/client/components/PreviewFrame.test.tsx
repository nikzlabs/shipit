import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PreviewFrame, formatErrorForMessage, type PreviewStatus } from "./PreviewFrame.js";
import type { PreviewError } from "../hooks/usePreviewErrors.js";

// Mock fetch so the URL-reachability poll resolves immediately in tests
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
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
  autoFixEnabled: false,
  onToggleAutoFix: vi.fn(),
  autoFixRetries: 0,
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
  it("shows placeholder when preview is null and no session", () => {
    render(<PreviewFrame preview={null} {...defaultProps} />);
    expect(screen.getByText(/Preview will appear here/)).toBeInTheDocument();
  });

  it("shows spinner when preview is null but session is active", () => {
    render(<PreviewFrame preview={null} sessionId="abc-123" {...defaultProps} />);
    expect(screen.getByText("Starting dev server...")).toBeInTheDocument();
  });

  it("shows placeholder when preview is not running", () => {
    const preview: PreviewStatus = { running: false, port: 5173, url: "http://localhost:5173" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    expect(screen.getByText(/Preview will appear here/)).toBeInTheDocument();
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

    fireEvent.click(screen.getByText("Reload"));
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

  it("calls onToggleAutoFix when toggle is clicked", () => {
    const onToggleAutoFix = vi.fn();
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} onToggleAutoFix={onToggleAutoFix} />);
    fireEvent.click(screen.getByText("Auto-fix"));
    expect(onToggleAutoFix).toHaveBeenCalled();
  });

  it("shows retry count when auto-fix is active with retries", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} autoFixEnabled={true} autoFixRetries={2} />);
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

  // ---- Crash state tests ----

  it("shows crash state with error output when preview crashed", () => {
    const preview: PreviewStatus = { running: false, port: 5173, url: "http://localhost:5173" };
    render(
      <PreviewFrame
        preview={preview}
        {...defaultProps}
        crashInfo={{ exitCode: 1, output: "Error: Cannot find module '@rollup/rollup-linux-arm64-gnu'" }}
      />,
    );
    expect(screen.getByText(/Preview server crashed/)).toBeInTheDocument();
    expect(screen.getByText(/exit code 1/)).toBeInTheDocument();
    expect(screen.getByText(/Cannot find module/)).toBeInTheDocument();
  });

  it("shows crash state without output when output is empty", () => {
    render(
      <PreviewFrame
        preview={{ running: false, port: 5173, url: "http://localhost:5173" }}
        {...defaultProps}
        crashInfo={{ exitCode: 137, output: "" }}
      />,
    );
    expect(screen.getByText(/Preview server crashed/)).toBeInTheDocument();
    expect(screen.getByText(/exit code 137/)).toBeInTheDocument();
  });

  it("shows Retry button that calls onRestartPreview", () => {
    const onRestartPreview = vi.fn();
    render(
      <PreviewFrame
        preview={{ running: false, port: 5173, url: "http://localhost:5173" }}
        {...defaultProps}
        crashInfo={{ exitCode: 1, output: "some error" }}
        onRestartPreview={onRestartPreview}
      />,
    );
    const btn = screen.getByText("Retry");
    fireEvent.click(btn);
    expect(onRestartPreview).toHaveBeenCalled();
  });

  it("shows Fix with Claude button that calls onSendCrashToAgent", () => {
    const onSendCrashToAgent = vi.fn();
    render(
      <PreviewFrame
        preview={{ running: false, port: 5173, url: "http://localhost:5173" }}
        {...defaultProps}
        crashInfo={{ exitCode: 1, output: "some error" }}
        onSendCrashToAgent={onSendCrashToAgent}
      />,
    );
    const btn = screen.getByText("Fix with Claude");
    fireEvent.click(btn);
    expect(onSendCrashToAgent).toHaveBeenCalled();
  });

  it("does not show crash state when preview is running", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(
      <PreviewFrame
        preview={preview}
        {...defaultProps}
        crashInfo={{ exitCode: 1, output: "old error" }}
      />,
    );
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe).toBeInTheDocument();
    expect(screen.queryByText(/Preview server crashed/)).not.toBeInTheDocument();
  });

  it("shows crash state over placeholder when crashInfo is set", () => {
    render(
      <PreviewFrame
        preview={null}
        sessionId="abc"
        {...defaultProps}
        crashInfo={{ exitCode: 1, output: "crash output" }}
      />,
    );
    // Crash state should take priority over the "Starting dev server..." spinner
    expect(screen.getByText(/Preview server crashed/)).toBeInTheDocument();
    expect(screen.queryByText("Starting dev server...")).not.toBeInTheDocument();
  });

  // ---- Config missing tests ----

  it("shows config missing state with setup button", () => {
    const onInitPreviewConfig = vi.fn();
    render(
      <PreviewFrame
        preview={null}
        {...defaultProps}
        configMissing={true}
        onInitPreviewConfig={onInitPreviewConfig}
      />,
    );
    expect(screen.getByText(/No preview configuration found/)).toBeInTheDocument();
    const btn = screen.getByText("Set up with Claude");
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onInitPreviewConfig).toHaveBeenCalled();
  });

  it("shows config missing without button when onInitPreviewConfig is not provided", () => {
    render(
      <PreviewFrame preview={null} {...defaultProps} configMissing={true} />,
    );
    expect(screen.getByText(/No preview configuration found/)).toBeInTheDocument();
    expect(screen.queryByText("Set up with Claude")).not.toBeInTheDocument();
  });

  // ---- Install status tests ----

  it("shows install running state", () => {
    render(
      <PreviewFrame
        preview={null}
        {...defaultProps}
        installStatus={{ status: "running" }}
      />,
    );
    expect(screen.getByText(/Installing dependencies/)).toBeInTheDocument();
  });

  it("shows install error state with message", () => {
    render(
      <PreviewFrame
        preview={null}
        {...defaultProps}
        installStatus={{ status: "error", message: "exit code 1" }}
      />,
    );
    expect(screen.getByText(/Install failed/)).toBeInTheDocument();
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
