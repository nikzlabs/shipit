

import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PresentInlineCard } from "./PresentInlineCard.js";
import { usePresentStore } from "../stores/present-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { ShipitPointerSessionProvider } from "./message-markdown.js";
import type { PresentInlineCard as PresentInlineCardData } from "../../server/shared/types.js";

const PRESENT_ID = "pres_abc";

function card(over: Partial<PresentInlineCardData> = {}): PresentInlineCardData {
  return {
    presentId: PRESENT_ID,
    filePath: "/persist/chart.html",
    mimeType: "text/html",
    title: "Latency chart",
    createdAt: "2026-08-22T00:00:00.000Z",
    ...over,
  };
}

function seedArtifact(over: Partial<PresentInlineCardData> = {}, content?: string) {
  const c = card(over);
  usePresentStore.setState({
    presentations: [
      {
        presentId: c.presentId,
        mimeType: c.mimeType,
        filePath: c.filePath,
        createdAt: c.createdAt,
        inline: true,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(content !== undefined ? { content } : {}),
      },
    ],
    activePresentIndex: 0,
  });
  return c;
}

afterEach(() => {
  cleanup();
  usePresentStore.getState().reset();
  usePreviewStore.setState({ services: [], previewLinkIntent: null, selectedPort: null });
  useUiStore.setState({ toast: null });
  vi.restoreAllMocks();
});

describe("PresentInlineCard", () => {
  it("shows the title and the presented path in its header", () => {
    render(<PresentInlineCard card={seedArtifact({}, "<h1>hi</h1>")} />);
    expect(screen.getByText("Latency chart")).toBeTruthy();
    expect(screen.getByText("/persist/chart.html")).toBeTruthy();
  });

  it("falls back to the file's name when the artifact has no title", () => {
    const c = seedArtifact({ title: undefined, filePath: "/persist/deep/graph.html" }, "<p/>");
    render(<PresentInlineCard card={c} />);
    expect(screen.getByText("graph.html")).toBeTruthy();
  });

  it("renders HTML in a sandboxed frame with no same-origin access", () => {
    render(<PresentInlineCard card={seedArtifact({}, "<h1>chart</h1>")} />);
    const frame = document.querySelector("iframe");
    expect(frame).toBeTruthy();
    // The whole security posture of a rendered artifact: scripts run, nothing else.
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("srcdoc")).toContain("chart");
  });

  it("renders an image artifact as an img, not a frame", () => {
    const c = seedArtifact(
      { mimeType: "image/png", filePath: "/persist/shot.png" },
      "data:image/png;base64,AAAA",
    );
    render(<PresentInlineCard card={c} />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("renders markdown as text in ShipIt's own DOM", () => {
    const c = seedArtifact({ mimeType: "text/markdown", filePath: "/persist/notes.md" }, "# Findings");
    render(<PresentInlineCard card={c} />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText("Findings")).toBeTruthy();
  });

  it("says so when the artifact is no longer available", () => {

    render(<PresentInlineCard card={card()} />);
    expect(screen.getByText(/no longer available/i)).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("waits on the bytes rather than rendering an empty frame", () => {
    render(<PresentInlineCard card={seedArtifact()} />);
    expect(screen.getByText(/loading artifact/i)).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("re-renders when the artifact is re-presented under it", () => {
    render(<PresentInlineCard card={seedArtifact({}, "<h1>v1</h1>")} />);
    expect(document.querySelector("iframe")?.getAttribute("srcdoc")).toContain("v1");

    act(() => usePresentStore.getState().setContent(PRESENT_ID, "<h1>v2</h1>"));
    expect(document.querySelector("iframe")?.getAttribute("srcdoc")).toContain("v2");
  });

  it("fetches the bytes for an artifact that has none cached", async () => {
    useSessionStore.setState({ sessionId: "s1" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: "<h1>fetched</h1>" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PresentInlineCard card={seedArtifact()} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/sessions/s1/present/${PRESENT_ID}/content`);
    await vi.waitFor(() =>
      expect(document.querySelector("iframe")?.getAttribute("srcdoc")).toContain("fetched"),
    );
  });

  describe("pointers the artifact itself carries (req 14)", () => {
    it("opens the Preview for a pointer the inline frame reports", () => {
      usePreviewStore.setState({
        services: [{ name: "web", status: "running", port: 5173, preview: "auto" }],
        previewLinkIntent: null,
        selectedPort: null,
      });
      useSessionStore.setState({ sessionId: "s1" });
      render(<PresentInlineCard card={seedArtifact({}, '<a href="shipit-preview://web/x">go</a>')} />);

      const frame = document.querySelector("iframe")!;
      expect(frame.getAttribute("srcdoc")).toContain("link_click");
      window.dispatchEvent(new MessageEvent("message", {
        data: { source: "shipit-preview", type: "link_click", href: "shipit-preview://web/x" },
        source: frame.contentWindow,
        origin: "null",
      }));

      expect(usePreviewStore.getState().previewLinkIntent?.targetPath).toBe("/x");
    });

    it("refuses a click from a card belonging to another session's transcript", () => {
      usePreviewStore.setState({
        services: [{ name: "web", status: "running", port: 5173, preview: "auto" }],
        previewLinkIntent: null,
        selectedPort: null,
      });
      useSessionStore.setState({ sessionId: "s1" });
      render(
        <ShipitPointerSessionProvider value="sess-OLD">
          <PresentInlineCard card={seedArtifact({}, '<a href="shipit-preview://web/x">go</a>')} />
        </ShipitPointerSessionProvider>,
      );

      const frame = document.querySelector("iframe")!;
      window.dispatchEvent(new MessageEvent("message", {
        data: { source: "shipit-preview", type: "link_click", href: "shipit-preview://web/x" },
        source: frame.contentWindow,
        origin: "null",
      }));

      expect(usePreviewStore.getState().previewLinkIntent).toBeNull();
      expect(useUiStore.getState().toast).toBeNull();
    });

    it("makes a pointer in an inline markdown artifact clickable", () => {
      usePreviewStore.setState({
        services: [{ name: "web", status: "running", port: 5173, preview: "auto" }],
        previewLinkIntent: null,
        selectedPort: null,
      });
      useSessionStore.setState({ sessionId: "s1" });
      const c = seedArtifact(
        { mimeType: "text/markdown", filePath: "/persist/notes.md" },
        "See [run 1](shipit-preview://web/runs/1).",
      );
      render(<PresentInlineCard card={c} />);

      fireEvent.click(screen.getByRole("button", { name: "run 1" }));
      expect(usePreviewStore.getState().previewLinkIntent?.targetPath).toBe("/runs/1");
    });
  });

  it("opens the artifact in the Present tab", () => {
    usePresentStore.setState({ galleryOpen: true });
    render(<PresentInlineCard card={seedArtifact({}, "<h1>hi</h1>")} />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(useUiStore.getState().rightTab).toBe("present");
    expect(usePresentStore.getState().activePresentIndex).toBe(0);
  });
});
