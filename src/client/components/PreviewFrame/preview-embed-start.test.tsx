import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PreviewFrame, type PreviewStatus } from "../PreviewFrame.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import type { PreviewError } from "../../hooks/usePreviewErrors.js";

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

/**
 * A previewed page asking ShipIt to start the service one of its embeds names
 * (docs/313-embedded-preview-services req 5). The page holds no service status
 * and cannot send a WebSocket message, so every check lives on this side.
 */
describe("embed start requests", () => {
  const preview: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
  const ORIGIN = "http://localhost:5173";

  async function renderWithFrame(onEmbedStartService: (name: string) => void, paneVisible = true) {
    render(
      <PreviewFrame
        preview={preview}
        sessionId="s1"
        paneVisible={paneVisible}
        onEmbedStartService={onEmbedStartService}
        {...defaultProps}
      />,
    );
    return (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
  }

  const request = (init: MessageEventInit) =>
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "embed_start_service", name: "assetgen" },
      ...init,
    }));

  it("forwards a request from the active slot's own window", async () => {
    const onEmbedStartService = vi.fn();
    const iframe = await renderWithFrame(onEmbedStartService);

    request({ source: iframe.contentWindow, origin: ORIGIN });

    expect(onEmbedStartService).toHaveBeenCalledWith("assetgen");
  });

  it("ignores a request from a window that is not a slot", async () => {
    const onEmbedStartService = vi.fn();
    await renderWithFrame(onEmbedStartService);

    request({ source: window, origin: ORIGIN });

    expect(onEmbedStartService).not.toHaveBeenCalled();
  });

  it("ignores a request whose origin is not the slot's", async () => {
    const onEmbedStartService = vi.fn();
    const iframe = await renderWithFrame(onEmbedStartService);

    request({ source: iframe.contentWindow, origin: "http://evil.example" });

    expect(onEmbedStartService).not.toHaveBeenCalled();
  });

  // `visibility: hidden` is invisible to geometry, so the page's own
  // IntersectionObserver still reports an embed as on screen behind another tab.
  it("ignores a request while the pane is not visible", async () => {
    const onEmbedStartService = vi.fn();
    const iframe = await renderWithFrame(onEmbedStartService, false);

    request({ source: iframe.contentWindow, origin: ORIGIN });

    expect(onEmbedStartService).not.toHaveBeenCalled();
  });

  /**
   * What makes an embed an ordinary document rather than a crippled one
   * (docs/313-embedded-preview-services req 6): sandbox flags are inherited by
   * nested frames, so a `sandbox` here would give every embedded service an
   * opaque origin — no storage, and CORS refusal on its own assets.
   */
  it("mounts a container preview with no sandbox to inherit", async () => {
    usePreviewStore.getState().setServices([
      { name: "dev", status: "running", port: 3000, preview: "auto" },
    ]);
    render(
      <PreviewFrame
        preview={{ running: true, port: 3000, url: "/preview/abc/3000/", source: "detected" }}
        sessionId="abc"
        {...defaultProps}
      />,
    );

    const iframe = (await screen.findByTitle("Live Preview")) as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBeNull();
  });

  it("ignores a request that names nothing", async () => {
    const onEmbedStartService = vi.fn();
    const iframe = await renderWithFrame(onEmbedStartService);

    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "shipit-preview", type: "embed_start_service" },
      source: iframe.contentWindow,
      origin: ORIGIN,
    }));

    expect(onEmbedStartService).not.toHaveBeenCalled();
  });
});
