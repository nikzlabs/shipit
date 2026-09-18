import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreviewFrame, formatErrorForMessage, type PreviewStatus } from "./PreviewFrame.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { findPresetById } from "./device-presets.js";
import type { PreviewError } from "../hooks/usePreviewErrors.js";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  usePreviewStore.getState().reset();

  usePreviewStore.getState().clearPreviewPaths();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

    await user.click(screen.getByLabelText("Select preview port"));

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

    await screen.findByTitle("Live Preview");
  });

  it("reloads the current page in place instead of re-navigating to the entry URL", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "loaded" },
      source: iframe.contentWindow,
    }));

    const srcSetter = vi.fn();
    Object.defineProperty(iframe, "src", { set: srcSetter, get: () => "http://localhost:5173", configurable: true });

    fireEvent.click(screen.getByTitle("Refresh preview"));

    expect(postMessage).toHaveBeenCalledWith({ source: "shipit-toolbar", type: "reload" }, "*");
    expect(srcSetter).not.toHaveBeenCalled();
  });

  it("falls back to re-assigning src when the preview script never loaded", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    const srcSetter = vi.fn();
    Object.defineProperty(iframe, "src", { set: srcSetter, get: () => "http://localhost:5173", configurable: true });

    fireEvent.click(screen.getByTitle("Refresh preview"));

    expect(srcSetter).toHaveBeenCalledWith("http://localhost:5173");
    expect(postMessage).not.toHaveBeenCalledWith({ source: "shipit-toolbar", type: "reload" }, "*");
  });

  it("hands an agent-authored destination to the preview script instead of reloading", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "loaded" },
      source: iframe.contentWindow,
    }));
    const srcSetter = vi.fn();
    Object.defineProperty(iframe, "src", { set: srcSetter, get: () => "http://localhost:5173", configurable: true });

    usePreviewStore.getState().setPreviewLinkIntent({
      sessionId: "s1", service: "web", port: 5173, slotKey: "s1:5173",
      targetPath: "/requirements?focus=7#req-7", clickId: 1, startedAt: Date.now(),
    });

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      { source: "shipit-toolbar", type: "navigate", url: "http://localhost:5173/requirements?focus=7#req-7" },
      "http://localhost:5173",
    ));
    expect(srcSetter).not.toHaveBeenCalled();

    expect(usePreviewStore.getState().previewLinkIntent).toBeNull();
  });

  it("falls back to src for a destination in a preview with no injected script", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    const srcSetter = vi.fn();
    Object.defineProperty(iframe, "src", { set: srcSetter, get: () => "http://localhost:5173", configurable: true });

    usePreviewStore.getState().setPreviewLinkIntent({
      sessionId: "s1", service: "web", port: 5173, slotKey: "s1:5173",
      targetPath: "/requirements#req-7", clickId: 1, startedAt: Date.now(),
    });

    await vi.waitFor(() => expect(srcSetter).toHaveBeenCalledWith("http://localhost:5173/requirements#req-7"));
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "navigate" }),
      "*",
    );
  });

  it("links to the page the preview is currently on, not the entry URL", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;

    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "path", path: "/orders/8842?tab=open" },
      source: iframe.contentWindow,
    }));
    await screen.findByText("/orders/8842");

    expect(screen.getByTitle("Open preview in new tab")).toHaveAttribute(
      "href",
      "http://localhost:5173/orders/8842?tab=open",
    );
  });

  it("falls back to the entry URL when the page reported no path", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    await screen.findByTitle("Live Preview");

    expect(screen.getByTitle("Open preview in new tab")).toHaveAttribute("href", "http://localhost:5173");
  });

  it("opens the preview as a real link, so the platform's own link handling applies", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    await screen.findByTitle("Live Preview");

    const link = screen.getByTitle("Open preview in new tab");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("falls back to a disabled button when there is no preview to link to", () => {
    render(<PreviewFrame preview={null} {...defaultProps} />);

    const control = screen.getByTitle("Open preview in new tab");
    expect(control.tagName).toBe("BUTTON");
    expect(control).toBeDisabled();
  });

  it("shows the path an iframe reports, and updates it on client-side navigation", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;

    const report = (path: string) => window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "path", path },
      source: iframe.contentWindow,
    }));

    report("/orders/8842?tab=open");
    expect(await screen.findByText("/orders/8842")).toBeInTheDocument();
    expect(screen.getByText("?tab=open")).toBeInTheDocument();

    report("/settings/secrets");
    expect(await screen.findByText("/settings/secrets")).toBeInTheDocument();
    expect(screen.queryByText("/orders/8842")).not.toBeInTheDocument();
  });

  it("ignores a reported path that is not a same-document absolute path", async () => {
    // The value is authored by the previewed page. A protocol-relative

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;

    for (const path of ["//evil.example/x", "http://evil.example/x", "javascript:alert(1)", 42]) {
      window.dispatchEvent(new MessageEvent("message", {
        data: { source: "shipit-preview", type: "path", path },
        source: iframe.contentWindow,
      }));
    }

    expect(screen.queryByRole("button", { name: /Copy preview URL/ })).not.toBeInTheDocument();
  });

  it("does not show a path reported by a different session's background iframe", async () => {

    // must not overwrite what the visible one says.
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "path", path: "/visible" },
      source: iframe.contentWindow,
    }));
    expect(await screen.findByText("/visible")).toBeInTheDocument();

    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "path", path: "/from-nowhere" },
      source: window,
    }));
    expect(screen.queryByText("/from-nowhere")).not.toBeInTheDocument();
    expect(screen.getByText("/visible")).toBeInTheDocument();
  });

  it("recreates a dropped slot at the path it was last on, not the front page", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { unmount } = render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "path", path: "/orders/8842?tab=open" },
      source: iframe.contentWindow,
    }));
    await screen.findByText("/orders/8842");

    unmount();

    render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    expect(await screen.findByTitle("Live Preview")).toHaveAttribute(
      "src",
      "http://localhost:5173/orders/8842?tab=open",
    );
  });

  it("does not restore one slot's path into another slot", async () => {
    const previewA: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const previewB: PreviewStatus = { running: true, port: 3000, url: "http://localhost:3000", source: "vite" };
    const { unmount } = render(<PreviewFrame preview={previewA} sessionId="s1" {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "path", path: "/deep/route" },
      source: iframe.contentWindow,
    }));
    await screen.findByText("/deep/route");
    unmount();

    render(<PreviewFrame preview={previewB} sessionId="s2" {...defaultProps} />);
    expect(await screen.findByTitle("Live Preview")).toHaveAttribute("src", "http://localhost:3000");
  });

  it("posts a back-navigation message to the active iframe when Back is clicked", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe, "contentWindow", { value: { postMessage }, configurable: true });

    fireEvent.click(screen.getByTitle("Back"));
    expect(postMessage).toHaveBeenCalledWith(
      { source: "shipit-toolbar", type: "back" },
      "*",
    );
  });

  it("navigates the active iframe to its root when Home is clicked", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "loaded" },
      source: iframe.contentWindow,
    }));
    const srcSetter = vi.fn();
    Object.defineProperty(iframe, "src", { set: srcSetter, get: () => "http://localhost:5173", configurable: true });

    fireEvent.click(screen.getByTitle("Go to preview root"));

    expect(postMessage).toHaveBeenCalledWith(
      { source: "shipit-toolbar", type: "navigate", url: "http://localhost:5173/" },
      "http://localhost:5173",
    );
    expect(srcSetter).not.toHaveBeenCalled();
  });

  it("goes to the origin root even when the slot itself was recreated at a deep path", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { unmount } = render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    const first = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "path", path: "/orders/8842?tab=open" },
      source: first.contentWindow,
    }));
    await screen.findByText("/orders/8842");
    unmount();

    render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    expect(iframe).toHaveAttribute("src", "http://localhost:5173/orders/8842?tab=open");
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "loaded" },
      source: iframe.contentWindow,
    }));

    fireEvent.click(screen.getByTitle("Go to preview root"));

    expect(postMessage).toHaveBeenCalledWith(
      { source: "shipit-toolbar", type: "navigate", url: "http://localhost:5173/" },
      "http://localhost:5173",
    );
  });

  it("falls back to a document load at the origin root, not at the slot's deep path", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { unmount } = render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    const first = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "path", path: "/deep/route" },
      source: first.contentWindow,
    }));
    await screen.findByText("/deep/route");
    unmount();

    render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const srcSetter = vi.fn();
    Object.defineProperty(iframe, "src", {
      set: srcSetter, get: () => "http://localhost:5173/deep/route", configurable: true,
    });

    fireEvent.click(screen.getByTitle("Go to preview root"));

    expect(srcSetter).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("places Home right of the address-bar separator, between it and the path", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { container } = render(<PreviewFrame preview={preview} {...defaultProps} />);
    const device = screen.getByLabelText("Select device viewport");
    const home = screen.getByTitle("Go to preview root");

    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "path", path: "/orders" },
      source: iframe.contentWindow,
    }));
    const path = await screen.findByLabelText(/Copy preview URL/);
    const separators = [...container.querySelectorAll("span")]
      .filter((el) => el.children.length === 0 && el.textContent === "|");

    const follows = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(device, home)).toBe(true);
    expect(follows(home, path)).toBe(true);

    expect(separators.filter((s) => follows(device, s) && follows(s, home))).toHaveLength(1);
    expect(separators.filter((s) => follows(home, s))).toHaveLength(0);
  });

  it("keeps Home when the page has reported no path at all", async () => {

    // a preview with no injected script never reports one — which is exactly

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { container } = render(<PreviewFrame preview={preview} {...defaultProps} />);
    await screen.findByTitle("Live Preview");

    expect(screen.queryByLabelText(/Copy preview URL/)).not.toBeInTheDocument();
    const home = screen.getByTitle("Go to preview root");
    expect(home).toBeEnabled();

    const separators = [...container.querySelectorAll("span")]
      .filter((el) => el.children.length === 0 && el.textContent === "|");
    expect(separators.some((s) =>
      (s.compareDocumentPosition(home) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    )).toBe(true);
  });

  it("falls back to a document load at root when Home is clicked and the preview script never loaded", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    const srcSetter = vi.fn();
    Object.defineProperty(iframe, "src", { set: srcSetter, get: () => "http://localhost:5173", configurable: true });

    fireEvent.click(screen.getByTitle("Go to preview root"));

    expect(srcSetter).toHaveBeenCalledWith("http://localhost:5173/");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("does not render Home when the preview is not running", () => {
    render(<PreviewFrame preview={null} sessionId="session-a" {...defaultProps} />);
    expect(screen.queryByTitle("Go to preview root")).not.toBeInTheDocument();
  });

  it("renders Home disabled while the preview is running but no slot URL exists yet", () => {

    vi.stubEnv("VITE_API_HOST", "192.168.1.5:4123");
    usePreviewStore.getState().setServices([
      { name: "dev", status: "running", port: 3000, preview: "manual" },
    ]);
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
    expect(screen.getByTitle("Go to preview root")).toBeDisabled();
  });

  it("disables Back while the preview has no history entry of its own", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;

    const report = (canGoBack: unknown) => window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "path", path: "/", canGoBack },
      source: iframe.contentWindow,
    }));

    report(false);
    expect(await screen.findByTitle("Nothing to go back to in the preview")).toBeDisabled();

    report(true);
    expect(await screen.findByTitle("Back")).toBeEnabled();
  });

  it("leaves Back enabled when the preview does not report canGoBack", async () => {

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;

    for (const canGoBack of [undefined, "false", 0]) {
      window.dispatchEvent(new MessageEvent("message", {
        data: { source: "shipit-preview", type: "path", path: "/", canGoBack },
        source: iframe.contentWindow,
      }));
      expect(await screen.findByTitle("Back")).toBeEnabled();
    }
  });

  it("keeps the last reported canGoBack when a later message omits it", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const report = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "path", path: "/", ...data },
      source: iframe.contentWindow,
    }));

    report({ canGoBack: false });
    expect(await screen.findByTitle("Nothing to go back to in the preview")).toBeDisabled();

    report({ canGoBack: "yes-please" });
    expect(await screen.findByTitle("Nothing to go back to in the preview")).toBeDisabled();
  });

  it("tracks canGoBack per slot, so a background preview cannot disable Back", async () => {

    const previewA: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const previewB: PreviewStatus = { running: true, port: 3000, url: "http://localhost:3000", source: "vite" };
    const { rerender } = render(<PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />);
    await screen.findByTitle("Live Preview");

    rerender(<PreviewFrame preview={previewB} sessionId="session-b" {...defaultProps} />);
    const foreground = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const background = screen.getByTitle("Background Preview") as HTMLIFrameElement;
    expect(background).toHaveAttribute("src", "http://localhost:5173");

    const report = (iframe: HTMLIFrameElement, canGoBack: boolean) => window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "shipit-preview", type: "path", path: "/", canGoBack },
        source: iframe.contentWindow,
      }),
    );

    report(foreground, true);
    expect(await screen.findByTitle("Back")).toBeEnabled();

    report(background, false);
    expect(await screen.findByTitle("Back")).toBeEnabled();

    rerender(<PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />);
    expect(await screen.findByTitle("Nothing to go back to in the preview")).toBeDisabled();
  });

  it("replies to the SDK ready handshake with authoritative visibility", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "ready" },
      source: iframe.contentWindow,
      origin: "http://localhost:5173",
    }));

    expect(postMessage).toHaveBeenCalledWith({
      source: "shipit-preview",
      type: "visibility",
      visible: true,
    }, "http://localhost:5173");
  });

  it("rejects a ready handshake after the iframe navigates to another origin", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    postMessage.mockClear();

    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "ready" },
      source: iframe.contentWindow,
      origin: "https://unexpected.example",
    }));

    expect(postMessage).not.toHaveBeenCalled();
  });

  it("dispatches an SDK request only from the active exact-origin preview", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const onAgentInterfaceMessage = vi.fn().mockResolvedValue(undefined);
    render(<PreviewFrame
      preview={preview}
      {...defaultProps}
      onAgentInterfaceMessage={onAgentInterfaceMessage}
    />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;

    window.dispatchEvent(new MessageEvent("message", {
      data: {
        source: "shipit-preview",
        type: "agent_message",
        requestId: "sdk-1",
        payload: { text: "Apply the selected settings" },
      },
      source: iframe.contentWindow,
      origin: "http://localhost:5173",
    }));

    await vi.waitFor(() => {
      expect(onAgentInterfaceMessage).toHaveBeenCalledWith(
        "Apply the selected settings",
        { source: "agent_interface_sdk", surface: "preview" },
      );
    });
  });

  it("emits hidden visibility when a mounted preview stops running", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { rerender } = render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    postMessage.mockClear();

    rerender(<PreviewFrame preview={{ ...preview, running: false }} {...defaultProps} />);

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        source: "shipit-preview",
        type: "visibility",
        visible: false,
      }, "http://localhost:5173");
    });
  });

  it("stops a background slot rendering with display:none, not visibility:hidden", async () => {

    // Pinned because the difference is invisible in a screenshot diff and the

    const previewA: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const previewB: PreviewStatus = { running: true, port: 4173, url: "http://localhost:4173", source: "vite" };
    const { rerender } = render(<PreviewFrame preview={previewA} sessionId="s1" {...defaultProps} />);
    await screen.findByTitle("Live Preview");

    rerender(<PreviewFrame preview={previewB} sessionId="s1" {...defaultProps} />);
    const background = await screen.findByTitle("Background Preview");

    expect(background).toHaveClass("hidden");
    expect(background).not.toHaveClass("invisible");
    expect(background).toBeInTheDocument();
  });

  it("does not hide the slot the user is looking at", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    const active = await screen.findByTitle("Live Preview");

    expect(active).not.toHaveClass("hidden");
  });

  it("stops the active preview rendering when its pane is not on screen", async () => {

    // drawing behind the Files tree, because the ancestor that hides it uses

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { rerender } = render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe).not.toHaveClass("hidden");

    rerender(<PreviewFrame preview={preview} sessionId="s1" paneVisible={false} {...defaultProps} />);

    expect(await screen.findByTitle("Live Preview")).toHaveClass("hidden");
  });

  it("posts visible:false when its pane leaves the screen, and visible:true on return", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { rerender } = render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    postMessage.mockClear();

    rerender(<PreviewFrame preview={preview} sessionId="s1" paneVisible={false} {...defaultProps} />);
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        { source: "shipit-preview", type: "visibility", visible: false },
        "http://localhost:5173",
      );
    });

    postMessage.mockClear();
    rerender(<PreviewFrame preview={preview} sessionId="s1" paneVisible {...defaultProps} />);
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        { source: "shipit-preview", type: "visibility", visible: true },
        "http://localhost:5173",
      );
    });
  });

  it("answers the SDK handshake with visible:false while its pane is off screen", async () => {
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} sessionId="s1" paneVisible={false} {...defaultProps} />);
    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    postMessage.mockClear();

    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "ready" },
      source: iframe.contentWindow,
      origin: "http://localhost:5173",
    }));

    expect(postMessage).toHaveBeenCalledWith(
      { source: "shipit-preview", type: "visibility", visible: false },
      "http://localhost:5173",
    );
  });

  it("selector label matches selectedPort", () => {
    const preview: PreviewStatus = { running: true, port: 3001, url: "http://localhost:3001", source: "detected", detectedPorts: [3001, 8080] };
    render(<PreviewFrame preview={preview} {...defaultProps} detectedPorts={[3001, 8080]} selectedPort={8080} onSelectPort={vi.fn()} />);
    const trigger = screen.getByLabelText("Select preview port");
    expect(trigger).toHaveTextContent("localhost:8080");
  });

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

    expect(screen.queryByRole("region", { name: "Preview errors" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Toggle error panel"));
    expect(screen.getByRole("region", { name: "Preview errors" })).toBeInTheDocument();
    expect(screen.getByText("Uncaught TypeError: x is not a function")).toBeInTheDocument();

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

  it("shows the preview setup invite when composeNotConfigured is set", () => {
    usePreviewStore.getState().setComposeNotConfigured(true);
    render(<PreviewFrame preview={null} {...defaultProps} />);
    expect(screen.getByText("Your app can run here")).toBeInTheDocument();
    expect(screen.getByText(/app in this repo/)).toBeInTheDocument();
  });

  it("names no implementation detail in the preview setup invite", () => {
    usePreviewStore.getState().setComposeNotConfigured(true);
    const { container } = render(<PreviewFrame preview={null} {...defaultProps} />);

    expect(container.textContent).not.toMatch(/\bcompose\b/i);
    expect(container.textContent).not.toMatch(/shipit\.yaml/i);
    expect(container.textContent).not.toMatch(/\bdocker\b/i);
  });

  it("shows the ask-the-agent button in the preview setup invite", () => {
    usePreviewStore.getState().setComposeNotConfigured(true);
    const onSendComposeHintToAgent = vi.fn();
    render(<PreviewFrame preview={null} {...defaultProps} onSendComposeHintToAgent={onSendComposeHintToAgent} />);
    const btn = screen.getByText("Ask the agent to set it up");
    fireEvent.click(btn);
    expect(onSendComposeHintToAgent).toHaveBeenCalled();
  });

  it("clears composeNotConfigured when services arrive", () => {
    usePreviewStore.getState().setComposeNotConfigured(true);
    usePreviewStore.getState().setServices([{ name: "web", status: "running", port: 5173, preview: "auto" }]);
    expect(usePreviewStore.getState().composeNotConfigured).toBe(false);
  });

  it("shows the manual-only empty state with a Show services button when every service is manual", () => {
    usePreviewStore.getState().setServices([
      { name: "dev", status: "stopped", port: 3000, preview: "manual" },
    ]);

    const stoppedPreview: PreviewStatus = { running: false, port: 0, url: "" };
    render(<PreviewFrame preview={stoppedPreview} sessionId="abc" {...defaultProps} />);

    expect(screen.getByText("No preview running. Start a service to launch it.")).toBeInTheDocument();

    expect(screen.queryByTitle("Start dev")).not.toBeInTheDocument();

    expect(screen.queryByText("Show services")).not.toBeInTheDocument();
  });

  it("keeps the empty state buttonless even when the user collapsed the drawer", () => {
    usePreviewStore.getState().setServices([
      { name: "dev", status: "stopped", port: 3000, preview: "manual" },
    ]);
    usePreviewStore.getState().setServicesDrawerIdleCollapsed(true);
    const stoppedPreview: PreviewStatus = { running: false, port: 0, url: "" };
    render(<PreviewFrame preview={stoppedPreview} sessionId="abc" {...defaultProps} />);
    expect(screen.getByText("No preview running. Start a service to launch it.")).toBeInTheDocument();
    expect(screen.queryByText("Show services")).not.toBeInTheDocument();
  });

  it("shows the generic empty state when at least one service is auto", () => {
    usePreviewStore.getState().setServices([
      { name: "web", status: "stopped", port: 5173, preview: "auto" },
      { name: "dev", status: "stopped", port: 3000, preview: "manual" },
    ]);
    const stoppedPreview: PreviewStatus = { running: false, port: 0, url: "" };
    render(<PreviewFrame preview={stoppedPreview} sessionId="abc" {...defaultProps} />);

    expect(screen.getByText("No preview running")).toBeInTheDocument();

    expect(screen.queryByTitle("Start web")).not.toBeInTheDocument();
  });

  it("renders the iframe when preview.running flips true while a manual service is in services", async () => {

    // overlay must NOT show — the iframe should take over instead.
    usePreviewStore.getState().setServices([
      { name: "dev", status: "running", port: 3000, preview: "manual" },
    ]);
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
    // The manual-only overlay must not show — the iframe takes its place.
    expect(screen.queryByText("No preview running. Start a service to launch it.")).not.toBeInTheDocument();
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe).toBeInTheDocument();
  });

  it("shows the empty-state (not an infinite spinner) when the host can't carry a wildcard subdomain", () => {

    // PreviewFrame must explain why.
    vi.stubEnv("VITE_API_HOST", "192.168.1.5:4123");
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
    expect(screen.getByText("Preview not available over this host")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.5:4123")).toBeInTheDocument();
    expect(screen.queryByText("Connecting to dev server...")).not.toBeInTheDocument();

    // because the helper could keep passing while the component stopped

    expect(screen.getByText("http://192-168-1-5.sslip.io:4123")).toBeInTheDocument();
  });

  it("explains the constraint without inventing a host when none can be suggested", () => {

    // scope, so the empty state must stop at the explanation. A bogus concrete

    vi.stubEnv("VITE_API_HOST", "[2001:db8::1]:4123");
    render(
      <PreviewFrame
        preview={{
          running: true,
          port: 3000,
          url: "/preview/abc/3000/",
          source: "detected",
          detectedPorts: [3000],
        }}
        sessionId="abc"
        {...defaultProps}
        detectedPorts={[3000]}
      />,
    );
    expect(screen.getByText("Preview not available over this host")).toBeInTheDocument();
    expect(screen.queryByText(/sslip\.io/)).not.toBeInTheDocument();
  });

  it("mounts the iframe on the first pass, with no reachability check first", async () => {

    usePreviewStore.getState().setServices([
      { name: "dev", status: "running", port: 3000, preview: "manual" },
    ]);
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
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
    // Synchronous `getBy`, not `findBy`: a hung fetch must not be able to
    // delay the iframe, because nothing is waiting on one.
    const iframe = screen.getByTitle("Live Preview") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toBe("http://abc--3000.localhost:3000/");
  });

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

    await user.click(screen.getByLabelText("Select preview port"));
    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("Preview");
  });

  it("preserves session A iframe in pool while polling for session B", async () => {
    const previewA: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { rerender } = render(<PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />);

    await screen.findByTitle("Live Preview");
    expect(screen.getByTitle("Live Preview")).toHaveAttribute("src", "http://localhost:5173");

    // Use a fetch that never resolves to simulate polling delay
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const previewB: PreviewStatus = { running: true, port: 3000, url: "http://localhost:3000", source: "vite" };
    rerender(<PreviewFrame preview={previewB} sessionId="session-b" {...defaultProps} />);

    const iframe = screen.getByTitle("Background Preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:5173");
  });

  it("preserves session A iframe in pool during session switch with null preview", async () => {
    const previewA: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const { rerender } = render(<PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />);
    await screen.findByTitle("Live Preview");

    rerender(<PreviewFrame preview={null} sessionId="session-b" {...defaultProps} />);

    const iframe = screen.getByTitle("Background Preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:5173");
  });

  it("keeps a session iframe in the background pool after session switch", async () => {

    const previewA: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const previewB: PreviewStatus = { running: true, port: 3000, url: "http://localhost:3000", source: "vite" };
    const { rerender } = render(<PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />);
    await screen.findByTitle("Live Preview");

    rerender(<PreviewFrame preview={previewB} sessionId="session-b" {...defaultProps} />);

    await screen.findByTitle("Live Preview");
    expect(screen.getByTitle("Background Preview")).toHaveAttribute("src", "http://localhost:5173");
  });

  it("keeps iframe DOM order stable across A→B→A switches (no reorder → no reload)", async () => {

    // fix renders in stable insertion order, so an existing iframe never

    const order = (container: HTMLElement) =>
      [...container.querySelectorAll("iframe")].map((f) => f.getAttribute("src"));

    const previewA: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    const previewB: PreviewStatus = { running: true, port: 3000, url: "http://localhost:3000", source: "vite" };

    const { rerender, container } = render(
      <PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />,
    );
    await screen.findByTitle("Live Preview");
    expect(order(container)).toEqual(["http://localhost:5173"]);

    // Switch to B. A must stay at its original DOM position (index 0); B is

    rerender(<PreviewFrame preview={previewB} sessionId="session-b" {...defaultProps} />);
    await screen.findByTitle("Live Preview");
    expect(order(container)).toEqual(["http://localhost:5173", "http://localhost:3000"]);

    // Switch back to A. The order must remain identical — A is not promoted
    // back to the front, so its iframe node never moves (no reload).
    rerender(<PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />);
    await screen.findByTitle("Live Preview");
    expect(order(container)).toEqual(["http://localhost:5173", "http://localhost:3000"]);
  });

  it("shows spinner for fresh session start (no stale iframe)", () => {

    render(<PreviewFrame preview={null} sessionId="session-a" {...defaultProps} />);
    expect(screen.getByText("Starting dev server...")).toBeInTheDocument();
    expect(screen.queryByTitle("Live Preview")).not.toBeInTheDocument();
  });

  it("keeps the retained iframe (no re-poll, no remount) when the port keeps its owner", async () => {
    usePreviewStore.getState().setServices([
      { name: "web", status: "running", port: 3000, preview: "auto" },
    ]);
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
    const first = await screen.findByTitle("Live Preview");

    // must not remount the retained iframe.
    act(() => {
      usePreviewStore.getState().setServices([
        { name: "web", status: "running", port: 3000, preview: "auto" },
      ]);
    });
    await act(async () => {});

    expect(screen.getByTitle("Live Preview")).toBe(first);
  });

  it("recreates and remounts the slot when the port changes owner", async () => {

    usePreviewStore.getState().setServices([
      { name: "web", status: "running", port: 3000, preview: "auto" },
    ]);
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
    const first = await screen.findByTitle("Live Preview");

    act(() => {
      usePreviewStore.getState().setServices([
        { name: "api", status: "running", port: 3000, preview: "auto" },
      ]);
    });
    await act(async () => {});

    const second = await screen.findByTitle("Live Preview");
    expect(second).not.toBe(first);

    act(() => {
      usePreviewStore.getState().setServices([
        { name: "worker", status: "running", port: 3000, preview: "auto" },
      ]);
    });
    await act(async () => {});
    const third = await screen.findByTitle("Live Preview");
    expect(third).not.toBe(second);
  });

  it("does not drop the slot when the current owner is unknown (transient list state)", async () => {

    usePreviewStore.getState().setServices([
      { name: "web", status: "running", port: 3000, preview: "auto" },
    ]);
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
    const first = await screen.findByTitle("Live Preview");

    act(() => usePreviewStore.getState().setServices([]));
    await act(async () => {});

    act(() => {
      usePreviewStore.getState().setServices([
        { name: "web", status: "running", port: 3000, preview: "auto" },
      ]);
    });
    await act(async () => {});

    expect(screen.getByTitle("Live Preview")).toBe(first);
  });

  it("does not drop a slot that was created before its service was known", async () => {

    // undefined recorded owner never evicts (the conservative side of the

    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} sessionId="s1" {...defaultProps} />);
    const first = await screen.findByTitle("Live Preview");

    act(() => {
      usePreviewStore.getState().setServices([
        { name: "web", status: "running", port: 5173, preview: "auto" },
      ]);
    });
    await act(async () => {});

    expect(screen.getByTitle("Live Preview")).toBe(first);
  });

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
    const preset = findPresetById("iphone-16")!;
    usePreviewStore.setState({ devicePreset: preset, isLandscape: false, customSize: null });
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe.style.width).toBe("393px");
    expect(iframe.style.height).toBe("852px");
  });

  it("swaps width and height when isLandscape is true", async () => {
    const preset = findPresetById("iphone-16")!;
    usePreviewStore.setState({ devicePreset: preset, isLandscape: true, customSize: null });
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    const iframe = await screen.findByTitle("Live Preview");
    expect(iframe.style.width).toBe("852px");
    expect(iframe.style.height).toBe("393px");
  });

  it("shows dimension label when a preset is active", async () => {
    const preset = findPresetById("iphone-16")!;
    usePreviewStore.setState({ devicePreset: preset, isLandscape: false, customSize: null });
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);
    expect(screen.getByText(/393×852/)).toBeInTheDocument();
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

    expect(iframe.style.width).toBe("");
    expect(iframe.style.height).toBe("");
  });

  it("renders viewport resize handles only while the device frame is active (docs/278)", () => {
    usePreviewStore.setState({ devicePreset: null, isLandscape: false, customSize: null });
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} />);

    expect(screen.queryByTestId("viewport-resize-handles")).not.toBeInTheDocument();
    act(() => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-16"));
    });
    expect(screen.getByTestId("viewport-resize-handles")).toBeInTheDocument();
  });

  it("hides viewport resize handles when the pane is off screen", () => {
    usePreviewStore.setState({ devicePreset: findPresetById("iphone-16"), isLandscape: false, customSize: null });
    const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    render(<PreviewFrame preview={preview} {...defaultProps} paneVisible={false} />);
    expect(screen.queryByTestId("viewport-resize-handles")).not.toBeInTheDocument();
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

    const widthSpy = vi.spyOn(HTMLDivElement.prototype, "clientWidth", "get").mockReturnValue(400);
    const heightSpy = vi.spyOn(HTMLDivElement.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      const preset = findPresetById("ipad-air")!;
      usePreviewStore.setState({ devicePreset: preset, isLandscape: false, customSize: null });
      const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
      render(<PreviewFrame preview={preview} {...defaultProps} />);
      const iframe = await screen.findByTitle("Live Preview");

      const transform = iframe.style.transform;
      const match = /scale\(([^)]+)\)/.exec(transform);
      expect(match).not.toBeNull();
      const scale = Number(match![1]);
      expect(scale).toBeGreaterThan(0);
      expect(scale).toBeLessThan(1);

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

      expect(screen.queryByText(/\(\d+%\)/)).not.toBeInTheDocument();
    } finally {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
  });

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

  it("Configure button opens the per-repo Project Settings → Secrets tab", async () => {
    const { useUiStore } = await import("../stores/ui-store.js");
    const { useSessionStore } = await import("../stores/session-store.js");
    useSessionStore.setState({
      sessionId: "sess-1",
      sessions: [{
        id: "sess-1",
        title: "s",
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        remoteUrl: "https://github.com/org/repo.git",
      }],
    });
    usePreviewStore.getState().setSecrets({
      declared: [],
      missingByService: {},
      missingRequired: ["DATABASE_URL"],
    });
    render(<PreviewFrame preview={null} {...defaultProps} />);
    await userEvent.click(screen.getByTestId("secrets-missing-configure"));
    expect(useUiStore.getState().projectSettingsRepoUrl).toBe("https://github.com/org/repo.git");
    expect(useUiStore.getState().projectSettingsTab).toBe("secrets");
    useUiStore.getState().setProjectSettingsRepoUrl(null);
    useSessionStore.setState({ sessionId: undefined, sessions: [] });
  });

  it("does not arm the auth-block reload timer when the user returns to a previously-loaded session", async () => {

    // fake-timer ordering vs. the poll loop's microtasks), we observe the

    // marked as loaded, the auth-block effect must NOT schedule the

    vi.stubEnv("VITE_API_HOST", "example.com:3001");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ready: true }), { status: 200 })),
    );

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const MAX_AUTH_TIMEOUT_MS = 5000;
    const authTimers = () =>
      setTimeoutSpy.mock.calls.filter(
        ([, delay]) => typeof delay === "number" && delay === MAX_AUTH_TIMEOUT_MS,
      );

    try {
      const previewA: PreviewStatus = {
        running: true,
        port: 3000,
        url: "/preview/session-a/3000/",
        source: "detected",
      };
      const { rerender } = render(
        <PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />,
      );
      const iframeA = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;

      await vi.waitFor(() => {
        expect(authTimers().length).toBeGreaterThanOrEqual(1);
      });

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "shipit-preview", type: "loaded" },
          source: iframeA.contentWindow,
        }),
      );

      const previewB: PreviewStatus = {
        running: true,
        port: 5173,
        url: "/preview/session-b/5173/",
        source: "detected",
      };
      rerender(
        <PreviewFrame preview={previewB} sessionId="session-b" {...defaultProps} />,
      );

      setTimeoutSpy.mockClear();

      rerender(
        <PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />,
      );

      await Promise.resolve();
      await Promise.resolve();

      expect(authTimers()).toHaveLength(0);
      expect(screen.queryByText("Preview authentication required")).not.toBeInTheDocument();
    } finally {
      setTimeoutSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("does not re-arm the auth-block timer for a slot whose detection already concluded", async () => {

    // never reports "loaded" — a non-HTML root, a failed script injection, a

    vi.useFakeTimers();
    vi.stubEnv("VITE_API_HOST", "example.com:3001");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ready: true }), { status: 200 })),
    );
    const MAX_AUTH_TIMEOUT_MS = 5000;
    const MAX_AUTH_RETRIES = 2;

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const authTimers = () =>
      setTimeoutSpy.mock.calls.filter(([, delay]) => delay === MAX_AUTH_TIMEOUT_MS);

    try {
      const previewA: PreviewStatus = { running: true, port: 3000, url: "/preview/session-a/3000/", source: "detected" };
      const previewB: PreviewStatus = { running: true, port: 5173, url: "/preview/session-b/5173/", source: "detected" };
      const { rerender } = render(
        <PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />,
      );

      // `advanceTimersByTime` and no `act`, the verdict never appears however

      // and then a bounded retry loop both passed locally and lost the race on

      await vi.waitFor(() => expect(authTimers()).toHaveLength(1));
      for (let i = 0; i < MAX_AUTH_RETRIES + 1; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MAX_AUTH_TIMEOUT_MS + 1);
        });
      }
      expect(screen.getByText("Preview authentication required")).toBeInTheDocument();

      rerender(<PreviewFrame preview={previewB} sessionId="session-b" {...defaultProps} />);
      setTimeoutSpy.mockClear();
      rerender(<PreviewFrame preview={previewA} sessionId="session-a" {...defaultProps} />);

      expect(authTimers()).toHaveLength(0);
      expect(screen.getByText("Preview authentication required")).toBeInTheDocument();
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  describe("waiting for its own service", () => {
    const WEB = { name: "web", status: "running" as const, port: 3000, preview: "auto" as const };
    const API_STOPPED = { name: "api", status: "stopped" as const, port: 4000, preview: "auto" as const };

    // it fell back — `detectedPorts` never contains the stopped service.
    const RUNNING: PreviewStatus = {
      running: true, port: 3000, url: "/preview/s1/3000/", source: "detected", detectedPorts: [3000],
    };

    const NOTHING_RUNNING: PreviewStatus = {
      running: false, port: 4000, url: "/preview/s1/4000/", detectedPorts: [],
    };

    function rememberApi(): void {
      usePreviewStore.setState({ previewTargetMemory: { s1: { service: "api", port: 4000 } } });
    }

    function renderPane(props: {
      preview: PreviewStatus;
      detectedPorts: number[];
      onSelectPort?: () => void;
    }) {
      return render(
        <PreviewFrame
          preview={props.preview} sessionId="s1" {...defaultProps}
          detectedPorts={props.detectedPorts} selectedPort={4000}
          onSelectPort={props.onSelectPort ?? vi.fn()}
        />,
      );
    }

    it("says what it is waiting for instead of showing the other service", async () => {
      rememberApi();
      usePreviewStore.getState().setServices([WEB, API_STOPPED]);
      renderPane({ preview: RUNNING, detectedPorts: [3000] });

      expect(await screen.findByText("api is not running")).toBeInTheDocument();

      expect(screen.getByText("api")).toBeInTheDocument();
      expect(screen.queryByText("web")).not.toBeInTheDocument();
    });

    it("waits by name when another service declares the same port", async () => {

      rememberApi();
      usePreviewStore.getState().setServices([
        { ...WEB, status: "stopped", port: 4000 },
        { ...API_STOPPED, status: "running" },
      ]);
      renderPane({
        preview: { ...RUNNING, port: 4000, detectedPorts: [4000] },
        detectedPorts: [4000],
      });

      expect(await screen.findByTitle("Live Preview")).toBeInTheDocument();
      expect(screen.queryByText("web is not running")).not.toBeInTheDocument();
    });

    it("names the service even when it is the only one and everything is down", async () => {

      rememberApi();
      usePreviewStore.getState().setServices([{ ...API_STOPPED, status: "starting" }]);
      renderPane({ preview: NOTHING_RUNNING, detectedPorts: [] });

      expect(await screen.findByText("Waiting for api…")).toBeInTheDocument();
      expect(screen.queryByText("No preview running")).not.toBeInTheDocument();
    });

    it("shows a spinner while the service is starting", async () => {
      rememberApi();
      usePreviewStore.getState().setServices([WEB, { ...API_STOPPED, status: "starting" }]);
      renderPane({ preview: RUNNING, detectedPorts: [3000] });

      expect(await screen.findByText("Waiting for api…")).toBeInTheDocument();
      // The dot must agree with the overlay. `starting` is the warning colour;

      expect(document.querySelector(".bg-\\(--color-warning\\)")).toBeInTheDocument();
      expect(document.querySelector(".bg-\\(--color-success\\)")).not.toBeInTheDocument();
    });

    it("keeps the dot honest when the pane has no selector at all", async () => {

      rememberApi();
      usePreviewStore.getState().setServices([{ ...API_STOPPED, status: "starting" }]);
      renderPane({ preview: NOTHING_RUNNING, detectedPorts: [] });

      expect(await screen.findByText("Waiting for api…")).toBeInTheDocument();
      expect(screen.queryByLabelText("Select preview port")).not.toBeInTheDocument();
      expect(document.querySelector(".bg-\\(--color-warning\\)")).toBeInTheDocument();
      expect(document.querySelector(".bg-\\(--color-success\\)")).not.toBeInTheDocument();
    });

    it("surfaces the service's own error", async () => {
      rememberApi();
      usePreviewStore.getState().setServices([WEB, { ...API_STOPPED, status: "error", error: "exit 1" }]);
      renderPane({ preview: RUNNING, detectedPorts: [3000] });

      expect(await screen.findByText("api is not running")).toBeInTheDocument();
      expect(screen.getByText("exit 1")).toBeInTheDocument();
    });

    it("creates no slot for the port it is waiting on", async () => {
      rememberApi();
      usePreviewStore.getState().setServices([WEB, API_STOPPED]);
      renderPane({ preview: RUNNING, detectedPorts: [3000] });

      expect(await screen.findByText("api is not running")).toBeInTheDocument();

      // created slot is only ever promoted afterwards, never reloaded — so it

      expect(screen.queryByTitle("Live Preview")).not.toBeInTheDocument();
    });

    it("offers the running service in the selector, so the wait is escapable", async () => {
      rememberApi();
      usePreviewStore.getState().setServices([WEB, API_STOPPED]);
      const onSelectPort = vi.fn();
      renderPane({ preview: RUNNING, detectedPorts: [3000], onSelectPort });

      await userEvent.click(await screen.findByLabelText("Select preview port"));
      await userEvent.click(await screen.findByRole("menuitem", { name: /web/ }));
      expect(onSelectPort).toHaveBeenCalledWith(3000);
    });

    it("shows the preview once the service is running", async () => {
      rememberApi();
      usePreviewStore.getState().setServices([WEB, { ...API_STOPPED, status: "running" }]);
      renderPane({
        preview: { ...RUNNING, detectedPorts: [3000, 4000] },
        detectedPorts: [3000, 4000],
      });

      expect(await screen.findByTitle("Live Preview")).toBeInTheDocument();
      expect(screen.queryByText("api is not running")).not.toBeInTheDocument();
    });

    it("reloads the retained slot when the service comes back", async () => {
      rememberApi();
      usePreviewStore.getState().setServices([WEB, { ...API_STOPPED, status: "running" }]);
      const view = renderPane({
        preview: { ...RUNNING, detectedPorts: [3000, 4000] },
        detectedPorts: [3000, 4000],
      });
      const iframe = await screen.findByTitle("Live Preview");

      const deepUrl = "http://s1--4000.localhost:3000/deep";
      iframe.setAttribute("src", deepUrl);

      await act(async () => {
        usePreviewStore.getState().updateService({ ...API_STOPPED, status: "starting" });
      });
      view.rerender(
        <PreviewFrame
          preview={RUNNING} sessionId="s1" {...defaultProps}
          detectedPorts={[3000]} selectedPort={4000} onSelectPort={vi.fn()}
        />,
      );
      expect(await screen.findByText("Waiting for api…")).toBeInTheDocument();

      await act(async () => {
        usePreviewStore.getState().updateService({ ...API_STOPPED, status: "running" });
      });
      view.rerender(
        <PreviewFrame
          preview={{ ...RUNNING, detectedPorts: [3000, 4000] }} sessionId="s1" {...defaultProps}
          detectedPorts={[3000, 4000]} selectedPort={4000} onSelectPort={vi.fn()}
        />,
      );
      await screen.findByTitle("Live Preview");
      expect(iframe.getAttribute("src")).not.toBe(deepUrl);
      expect(iframe.getAttribute("src")).toBe("http://s1--4000.localhost:3000/");
    });

    it("does not reload another session's iframe when a switch ends the wait", async () => {
      usePreviewStore.setState({
        previewTargetMemory: {
          s1: { service: "api", port: 4000 },
          s2: { service: "web", port: 3000 },
        },
      });
      usePreviewStore.getState().setServices([WEB, API_STOPPED]);

      const s2 = (
        <PreviewFrame
          preview={{ ...RUNNING, url: "/preview/s2/3000/" }} sessionId="s2" {...defaultProps}
          detectedPorts={[3000]} selectedPort={3000} onSelectPort={vi.fn()}
        />
      );
      const view = render(s2);
      const iframe = await screen.findByTitle("Live Preview");

      const deepUrl = "http://s2--3000.localhost:3000/deep";
      iframe.setAttribute("src", deepUrl);

      view.rerender(
        <PreviewFrame
          preview={RUNNING} sessionId="s1" {...defaultProps}
          detectedPorts={[3000]} selectedPort={4000} onSelectPort={vi.fn()}
        />,
      );
      expect(await screen.findByText("api is not running")).toBeInTheDocument();

      // a recovery and reloads s2's retained iframe, which never waited at all.
      view.rerender(s2);
      await screen.findByTitle("Live Preview");
      expect(iframe.getAttribute("src")).toBe(deepUrl);
    });
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
