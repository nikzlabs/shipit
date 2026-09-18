import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { PreviewServicesDrawer } from "./PreviewServicesDrawer.js";
import { usePreviewStore, type ManagedServiceState } from "../stores/preview-store.js";
import { useLogStore } from "../stores/log-store.js";

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
  previewRunning: true,
});

beforeEach(() => {
  localStorage.clear();

  usePreviewStore.setState({ servicesDrawerExpanded: false, servicesDrawerIdleCollapsed: false });
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

    const view = screen.getByTestId("log-view");
    expect(view.getAttribute("data-channel")).toBe("service:web");

    expect(screen.getByText("Send to Agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop web" })).toBeInTheDocument();
    // ...and there is no "Back to services" since we never left it.
    expect(screen.queryByRole("button", { name: "Back to services" })).toBeNull();
  });

  it("with multiple services, drilling into one mounts its log view + toolbar", () => {
    const services = [svc({ name: "web", port: 3000 }), svc({ name: "db", status: "stopped" })];
    render(<PreviewServicesDrawer services={services} {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    fireEvent.click(screen.getByRole("button", { name: "View web logs" }));

    expect(screen.getByRole("button", { name: "Back to services" })).toBeInTheDocument();
    expect(screen.getByText("Send to Agent")).toBeInTheDocument();

    const view = screen.getByTestId("log-view");
    expect(view.getAttribute("data-channel")).toBe("service:web");
  });

  it("clicking a service name pivots the preview to it instead of opening logs", () => {
    const props = baseProps();
    const services = [svc({ name: "web", port: 3000 }), svc({ name: "api", port: 4000 })];
    render(<PreviewServicesDrawer services={services} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand services" }));
    fireEvent.click(screen.getByRole("button", { name: "api" }));
    expect(props.onSelectPreviewPort).toHaveBeenCalledWith(4000);

    expect(screen.queryByRole("button", { name: "Back to services" })).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "View web logs" }));
    expect(screen.getByRole("button", { name: "Back to services" })).toBeInTheDocument();

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

    expect(props.send).toHaveBeenCalledWith({ type: "stop_service", name: "web" });
    expect(props.send).not.toHaveBeenCalledWith({ type: "start_service", name: "web" });

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

  describe("a long crash error cannot squeeze out the log", () => {
    const LONG_STDERR = "Error response from daemon: OCI runtime create failed\n".repeat(24);

    it("bounds the error message's height and scrolls the overflow", () => {
      const services = [svc({ name: "db", status: "error", error: LONG_STDERR })];
      render(<PreviewServicesDrawer services={services} {...baseProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "Expand services" }));

      const box = screen.getByRole("group", { name: "db error detail" });
      expect(box).toHaveClass("max-h-20", "overflow-y-auto");

      expect(box).toHaveAttribute("tabindex", "0");
    });

    it("gives the log view a flex-1 min-h-0 slot so it takes the leftover space", () => {
      const services = [svc({ name: "db", status: "error", error: LONG_STDERR })];
      render(<PreviewServicesDrawer services={services} {...baseProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "Expand services" }));

      // `<LogView>`'s own root is `h-full`, whose min-content height it cannot

      const slot = screen.getByTestId("service-log-slot");
      expect(slot).toHaveClass("flex-1", "min-h-0");
      expect(slot).toContainElement(screen.getByTestId("log-view"));
    });
  });
});

describe("PreviewServicesDrawer — opens itself while no preview runs", () => {
  const idleProps = () => ({ ...baseProps(), previewRunning: false });

  it("is expanded with no preview running, even though the saved preference is collapsed", () => {
    localStorage.setItem("shipit:preview-services:expanded", "0");
    usePreviewStore.setState({ servicesDrawerExpanded: false });
    render(<PreviewServicesDrawer services={[svc({ name: "dev", status: "stopped" })]} {...idleProps()} />);

    expect(screen.getByRole("button", { name: "Start service" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse services" })).toBeInTheDocument();
  });

  it("a hand collapse holds while no preview runs", () => {
    render(<PreviewServicesDrawer services={[svc({ name: "dev", status: "stopped" })]} {...idleProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse services" }));
    expect(screen.getByRole("button", { name: "Expand services" })).toBeInTheDocument();
    expect(usePreviewStore.getState().servicesDrawerIdleCollapsed).toBe(true);
  });

  it("a preview starting ends that collapse, so the next stop opens the drawer again", () => {
    const props = idleProps();
    const services = [svc({ name: "dev", status: "stopped" })];
    const { rerender } = render(<PreviewServicesDrawer services={services} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse services" }));

    rerender(<PreviewServicesDrawer services={[svc({ name: "dev" })]} {...props} previewRunning />);
    expect(usePreviewStore.getState().servicesDrawerIdleCollapsed).toBe(false);
    expect(screen.getByRole("button", { name: "Expand services" })).toBeInTheDocument();

    rerender(<PreviewServicesDrawer services={services} {...props} />);
    expect(screen.getByRole("button", { name: "Collapse services" })).toBeInTheDocument();
  });
});
