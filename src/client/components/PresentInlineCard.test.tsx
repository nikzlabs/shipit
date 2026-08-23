/**
 * PresentInlineCard tests (docs/280).
 *
 * The card is metadata-only by design, so the behaviour worth pinning is what
 * it does with an artifact it does NOT hold: fetch it lazily, re-render when the
 * bytes change under it (that is how a re-present refreshes the card in place),
 * and degrade to a placeholder rather than a broken frame when the artifact is
 * gone. Rendering per kind is asserted at the boundary each kind is visible at —
 * an iframe for HTML/SVG, an `<img>` for images, text for markdown/plain.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PresentInlineCard } from "./PresentInlineCard.js";
import { usePresentStore } from "../stores/present-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
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

/** Seed the store with the artifact the card points at, optionally with bytes. */
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
    // Card in the transcript, artifact gone from the store (session cleared).
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

    // A re-present drops the cached bytes and the refetch caches new ones; the
    // card follows the artifact instead of freezing at the version it was
    // emitted with — this is what makes one card enough for the whole loop.
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

  it("opens the artifact in the Present tab", () => {
    usePresentStore.setState({ galleryOpen: true });
    render(<PresentInlineCard card={seedArtifact({}, "<h1>hi</h1>")} />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(useUiStore.getState().rightTab).toBe("present");
    expect(usePresentStore.getState().activePresentIndex).toBe(0);
  });
});
