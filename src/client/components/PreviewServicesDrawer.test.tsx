import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { PreviewServicesDrawer } from "./PreviewServicesDrawer.js";
import { usePreviewStore, type ManagedServiceState } from "../stores/preview-store.js";

// xterm has no DOM/canvas in jsdom — mock it (mirrors InteractiveTerminal.test.tsx).
const terminalInstances: { write: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] = [];
vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    write = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    constructor() { terminalInstances.push(this); }
  }
  return { Terminal: MockTerminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { activate = vi.fn(); } }));

vi.stubGlobal("ResizeObserver", class {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
});

function svc(over: Partial<ManagedServiceState> & { name: string }): ManagedServiceState {
  return { status: "running", preview: "auto", ...over };
}

const baseProps = () => ({
  active: true,
  lastMessage: null as MessageEvent | null,
  drainMessages: () => [] as MessageEvent[],
  send: vi.fn(),
  onSendToAgent: vi.fn(),
  onSelectPreviewPort: vi.fn(),
});

beforeEach(() => {
  terminalInstances.length = 0;
  localStorage.clear();
  // The preview store is a module singleton; reset the lifted drawer flag so
  // a prior test's expand doesn't leak into the next case.
  usePreviewStore.setState({ servicesDrawerExpanded: false });
});
afterEach(cleanup);

describe("PreviewServicesDrawer", () => {
  it("renders nothing when there are no services", () => {
    const { container } = render(<PreviewServicesDrawer services={[]} {...baseProps()} />);
    expect(container.querySelector('[data-testid="preview-services-drawer"]')).toBeNull();
  });

  it("is collapsed by default: header shows running/total count, body is hidden", () => {
    const services = [svc({ name: "web", port: 3000 }), svc({ name: "db", status: "stopped" })];
    render(<PreviewServicesDrawer services={services} {...baseProps()} />);
    expect(screen.getByText("Services")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    // Service rows (list view) are not rendered while collapsed.
    expect(screen.queryByText("web")).toBeNull();
  });

  it("expands on header click and shows the service list", () => {
    const services = [svc({ name: "web", port: 3000 })];
    render(<PreviewServicesDrawer services={services} {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    expect(screen.getByText("web")).toBeInTheDocument();
  });

  it("drills into a service's log view and mounts the xterm viewer when active", () => {
    const services = [svc({ name: "web", port: 3000 })];
    render(<PreviewServicesDrawer services={services} {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    fireEvent.click(screen.getByRole("button", { name: "web" }));
    // Log toolbar affordances appear...
    expect(screen.getByRole("button", { name: "Back to services" })).toBeInTheDocument();
    expect(screen.getByText("Send to Agent")).toBeInTheDocument();
    // ...and the (mocked) terminal was instantiated.
    expect(terminalInstances.length).toBe(1);
  });

  it("does NOT mount xterm in the log view when the preview tab is inactive", () => {
    const services = [svc({ name: "web", port: 3000 })];
    render(<PreviewServicesDrawer services={services} {...baseProps()} active={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    fireEvent.click(screen.getByRole("button", { name: "web" }));
    expect(terminalInstances.length).toBe(0);
  });

  it("clicking a service's port chip pivots the preview port", () => {
    const services = [svc({ name: "web", port: 3000 })];
    const props = baseProps();
    render(<PreviewServicesDrawer services={services} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    fireEvent.click(screen.getByText(":3000"));
    expect(props.onSelectPreviewPort).toHaveBeenCalledWith(3000);
  });

  it("persists the expanded state to localStorage", () => {
    const services = [svc({ name: "web", port: 3000 })];
    render(<PreviewServicesDrawer services={services} {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    expect(localStorage.getItem("shipit:preview-services:expanded")).toBe("1");
  });

  it("restart sends stop now, then start once the service reports stopped", () => {
    const props = baseProps();
    const services = [svc({ name: "web", port: 3000, status: "running" })];
    const { rerender } = render(<PreviewServicesDrawer services={services} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart web" }));
    // Stop is dispatched immediately; start is deferred until "stopped" arrives.
    expect(props.send).toHaveBeenCalledWith({ type: "stop_service", name: "web" });
    expect(props.send).not.toHaveBeenCalledWith({ type: "start_service", name: "web" });
    // Service transitions to stopped → the deferred start fires.
    rerender(<PreviewServicesDrawer services={[svc({ name: "web", port: 3000, status: "stopped" })]} {...props} />);
    expect(props.send).toHaveBeenCalledWith({ type: "start_service", name: "web" });
  });

  it("'Stop all' stops every running/starting service", () => {
    const props = baseProps();
    const services = [
      svc({ name: "web", port: 3000, status: "running" }),
      svc({ name: "worker", status: "starting" }),
      svc({ name: "db", status: "stopped" }),
    ];
    render(<PreviewServicesDrawer services={services} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
    expect(props.send).toHaveBeenCalledWith({ type: "stop_service", name: "web" });
    expect(props.send).toHaveBeenCalledWith({ type: "stop_service", name: "worker" });
    expect(props.send).not.toHaveBeenCalledWith({ type: "stop_service", name: "db" });
  });

  it("'Start all' appears when nothing is running and starts the stopped services", () => {
    const props = baseProps();
    const services = [svc({ name: "web", status: "stopped" }), svc({ name: "db", status: "error" })];
    render(<PreviewServicesDrawer services={services} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    fireEvent.click(screen.getByRole("button", { name: "Start all" }));
    expect(props.send).toHaveBeenCalledWith({ type: "start_service", name: "web" });
    expect(props.send).toHaveBeenCalledWith({ type: "start_service", name: "db" });
  });

  it("a crashed service shows its error and an 'ask the agent to fix' action", () => {
    const props = baseProps();
    const services = [svc({ name: "db", status: "error", error: "exit 137 (OOM)" })];
    render(<PreviewServicesDrawer services={services} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    expect(screen.getByText("exit 137 (OOM)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Ask the agent to fix/ }));
    expect(props.onSendToAgent).toHaveBeenCalledWith("db", "error", "exit 137 (OOM)");
  });
});
