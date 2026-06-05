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
});
