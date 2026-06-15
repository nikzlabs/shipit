import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { PreviewServicesDrawer } from "./PreviewServicesDrawer.js";
import { usePreviewStore, type ManagedServiceState } from "../stores/preview-store.js";
import { useLogStore } from "../stores/log-store.js";

// LogView owns an xterm.js instance (no DOM/canvas in jsdom). These tests are
// about the drawer (list, selection, toolbar, restart) — stub LogView to a
// marker that echoes its channel so we can assert it mounts for the selected
// service when the preview tab is active.
vi.mock("./LogView.js", () => ({
  LogView: ({ channel }: { channel: string }) => (
    <div data-testid="log-view" data-channel={channel} />
  ),
}));

function svc(over: Partial<ManagedServiceState> & { name: string }): ManagedServiceState {
  return { status: "running", preview: "auto", ...over };
}

const baseProps = () => ({
  active: true,
  send: vi.fn(),
  onSendToAgent: vi.fn(),
  onSelectPreviewPort: vi.fn(),
});

beforeEach(() => {
  localStorage.clear();
  // The preview store is a module singleton; reset the lifted drawer flag so
  // a prior test's expand doesn't leak into the next case.
  usePreviewStore.setState({ servicesDrawerExpanded: false });
  useLogStore.getState().reset();
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

  it("expands on header click and shows the service", () => {
    const services = [svc({ name: "web", port: 3000 })];
    render(<PreviewServicesDrawer services={services} {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    expect(screen.getByText("web")).toBeInTheDocument();
  });

  it("a single service shows its log directly in a focus card (no drill-in)", () => {
    const services = [svc({ name: "web", port: 3000 })];
    render(<PreviewServicesDrawer services={services} {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    // The log is mounted on the service channel without any drill-in click...
    const view = screen.getByTestId("log-view");
    expect(view.getAttribute("data-channel")).toBe("service:web");
    // ...the focus card carries its own controls (left-grouped)...
    expect(screen.getByText("Send to Agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop web" })).toBeInTheDocument();
    // ...and there is no "Back to services" since we never left it.
    expect(screen.queryByRole("button", { name: "Back to services" })).toBeNull();
  });

  it("with multiple services, drilling into one mounts its log view + toolbar", () => {
    const services = [svc({ name: "web", port: 3000 }), svc({ name: "db", status: "stopped" })];
    render(<PreviewServicesDrawer services={services} {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    fireEvent.click(screen.getByRole("button", { name: "web" }));
    // Log toolbar affordances appear...
    expect(screen.getByRole("button", { name: "Back to services" })).toBeInTheDocument();
    expect(screen.getByText("Send to Agent")).toBeInTheDocument();
    // ...and the LogView mounted on the service channel.
    const view = screen.getByTestId("log-view");
    expect(view.getAttribute("data-channel")).toBe("service:web");
  });

  it("does NOT mount the LogView when the preview tab is inactive", () => {
    const services = [svc({ name: "web", port: 3000 })];
    render(<PreviewServicesDrawer services={services} {...baseProps()} active={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    expect(screen.queryByTestId("log-view")).toBeNull();
  });

  it("a stopped single service shows a Start action instead of a blank log", () => {
    const props = baseProps();
    const services = [svc({ name: "web", status: "stopped" })];
    render(<PreviewServicesDrawer services={services} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    // No terminal for a not-running service — a purposeful empty state instead.
    expect(screen.queryByTestId("log-view")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start service" }));
    expect(props.send).toHaveBeenCalledWith({ type: "start_service", name: "web" });
  });

  it("a crashed single service with no error message still offers a fix", () => {
    const props = baseProps();
    const services = [svc({ name: "web", status: "error" })];
    render(<PreviewServicesDrawer services={services} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    expect(screen.getByText("Service crashed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Ask the agent to fix/ }));
    expect(props.onSendToAgent).toHaveBeenCalledWith("web", "error", "");
  });

  it("a stale selection from multi-service does not trap the lone service in drill-in", () => {
    const props = baseProps();
    const two = [svc({ name: "web", port: 3000 }), svc({ name: "db", status: "stopped" })];
    const { rerender } = render(<PreviewServicesDrawer services={two} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    fireEvent.click(screen.getByRole("button", { name: "web" }));
    expect(screen.getByRole("button", { name: "Back to services" })).toBeInTheDocument();
    // db disappears → only web remains → fall back to the focus card, not the
    // drill-in toolbar with its dangling "Back to services".
    rerender(<PreviewServicesDrawer services={[svc({ name: "web", port: 3000 })]} {...props} />);
    expect(screen.queryByRole("button", { name: "Back to services" })).toBeNull();
    expect(screen.getByTestId("log-view").getAttribute("data-channel")).toBe("service:web");
  });

  it("Send to Agent from the focus card ships the service's recent log lines", () => {
    const props = baseProps();
    useLogStore.getState().snapshot("service:web", [{ ts: "", source: "stdout", text: "boot\nready\n" }]);
    const services = [svc({ name: "web", port: 3000 })];
    render(<PreviewServicesDrawer services={services} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    fireEvent.click(screen.getByText("Send to Agent"));
    expect(props.onSendToAgent).toHaveBeenCalledWith("web", "running", "boot\nready");
  });

  it("clicking a single service's port chip pivots the preview port", () => {
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
