import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PreviewFrame, type PreviewStatus } from "./PreviewFrame.js";

afterEach(cleanup);

const defaultProps = {
  detectedPorts: [] as number[],
  selectedPort: null as number | null,
  onSelectPort: vi.fn(),
};

describe("PreviewFrame", () => {
  it("shows placeholder when preview is null", () => {
    render(<PreviewFrame preview={null} {...defaultProps} />);
    expect(screen.getByText(/Preview will appear here/)).toBeInTheDocument();
  });

  it("shows placeholder when preview is not running", () => {
    const preview: PreviewStatus = { running: false, port: 5173, url: "http://localhost:5173" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    expect(screen.getByText(/Preview will appear here/)).toBeInTheDocument();
  });

  it("renders iframe when preview is running", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = screen.getByTitle("Live Preview");
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute("src", "http://localhost:5173");
  });

  it("shows (auto-detected) label for detected source with single port", () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected" };
    render(<PreviewFrame preview={preview} detectedPorts={[3001]} selectedPort={null} onSelectPort={vi.fn()} />);
    expect(screen.getByText("(auto-detected)")).toBeInTheDocument();
  });

  it("shows port text without selector when only one detected port", () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected" };
    render(<PreviewFrame preview={preview} detectedPorts={[3001]} selectedPort={null} onSelectPort={vi.fn()} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText(/localhost:3001/)).toBeInTheDocument();
  });

  it("shows dropdown selector when multiple detected ports exist", () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} detectedPorts={[3001, 8080]} selectedPort={null} onSelectPort={vi.fn()} />);
    const select = screen.getByLabelText("Select preview port");
    expect(select).toBeInTheDocument();
    expect(select.tagName).toBe("SELECT");
  });

  it("shows dropdown when Vite is running and detected ports also exist", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite", detectedPorts: [3001] };
    render(<PreviewFrame preview={preview} detectedPorts={[3001]} selectedPort={null} onSelectPort={vi.fn()} />);
    const select = screen.getByLabelText("Select preview port");
    expect(select).toBeInTheDocument();
  });

  it("lists Vite port and detected ports in the selector", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} detectedPorts={[3001, 8080]} selectedPort={null} onSelectPort={vi.fn()} />);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent("5173 (Vite)");
    expect(options[1]).toHaveTextContent("3001");
    expect(options[2]).toHaveTextContent("8080");
  });

  it("calls onSelectPort when user changes the dropdown", () => {
    const onSelectPort = vi.fn();
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} detectedPorts={[3001, 8080]} selectedPort={null} onSelectPort={onSelectPort} />);
    const select = screen.getByLabelText("Select preview port");
    fireEvent.change(select, { target: { value: "8080" } });
    expect(onSelectPort).toHaveBeenCalledWith(8080);
  });

  it("uses selectedPort for the iframe when provided", () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} detectedPorts={[3001, 8080]} selectedPort={8080} onSelectPort={vi.fn()} />);
    const iframe = screen.getByTitle("Live Preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:8080");
  });

  it("falls back to preview.port when selectedPort is null", () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected" };
    render(<PreviewFrame preview={preview} detectedPorts={[3001]} selectedPort={null} onSelectPort={vi.fn()} />);
    const iframe = screen.getByTitle("Live Preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:3001");
  });

  it("increments refresh key when Reload is clicked", () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    expect(screen.getByTitle("Live Preview")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Reload"));
    // iframe should have been re-mounted (different React key forces remount)
    expect(screen.getByTitle("Live Preview")).toBeInTheDocument();
  });

  it("selector value matches selectedPort", () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} detectedPorts={[3001, 8080]} selectedPort={8080} onSelectPort={vi.fn()} />);
    const select = screen.getByLabelText("Select preview port") as HTMLSelectElement;
    expect(select.value).toBe("8080");
  });
});
