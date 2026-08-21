import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  PresentPane,
  mimeTypeToExtension,
  suggestDownloadName,
  presentationToBlob,
} from "./PresentPane.js";
import { usePresentStore } from "../stores/present-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";

// PresentPane → FileContentView → CodeEditor does `import("monaco-editor")`.
// Unstubbed, that dynamic import keeps resolving Monaco's module graph after
// this file's environment is torn down, which Vitest reports as an unhandled
// EnvironmentTeardownError and fails the run even with every test green. Same
// stub the other Monaco-adjacent suites use.
vi.mock("monaco-editor", () => ({
  editor: {
    create: () => ({
      dispose: vi.fn(),
      onMouseDown: () => ({ dispose: vi.fn() }),
      onMouseMove: () => ({ dispose: vi.fn() }),
      onMouseLeave: () => ({ dispose: vi.fn() }),
      // The comment widget keeps its cards sized to, and aligned with, the
      // visible content area, so it subscribes to scroll and layout too.
      onDidScrollChange: () => ({ dispose: vi.fn() }),
      onDidLayoutChange: () => ({ dispose: vi.fn() }),
      getLayoutInfo: () => ({ contentWidth: 800 }),
      getScrollLeft: () => 0,
      updateOptions: vi.fn(),
      changeViewZones: vi.fn(),
      createDecorationsCollection: vi.fn(),
      getModel: () => ({ getLineCount: () => 1 }),
    }),
  },
}));

function meta(over: { presentId: string; title?: string; filePath?: string; mimeType?: string }) {
  return {
    presentId: over.presentId,
    mimeType: over.mimeType ?? "text/html",
    filePath: over.filePath ?? `/tmp/${over.presentId}.html`,
    createdAt: "2026-05-31T00:00:00.000Z",
    ...(over.title !== undefined ? { title: over.title } : {}),
  };
}

function seedPresentations() {
  usePresentStore.getState().hydrate([
    meta({ presentId: "pres_one", title: "One", filePath: "/tmp/one.html" }),
    meta({ presentId: "pres_two", title: "Two", filePath: "/tmp/two.html" }),
  ]);
}

/**
 * Stub the lazy content fetch (`GET …/present/:id/content`). `bytes` maps a
 * presentId to the artifact text returned; an unknown id yields a 404.
 */
function mockContentFetch(bytes: Record<string, string>, mimeType = "text/html") {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    const id = /\/present\/([^/]+)\/content$/.exec(url)?.[1];
    const content = id ? bytes[id] : undefined;
    if (content === undefined) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ error: "Presentation not found" }),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ content, mimeType }),
    } as unknown as Response);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  usePresentStore.getState().reset();
  useSessionStore.getState().setSessionId(undefined);
  useUiStore.setState({ toast: null });
});

describe("PresentPane", () => {
  it("renders the empty state when there are no presentations", () => {
    render(<PresentPane isActiveTab />);
    expect(screen.getByText(/Nothing to present yet/)).toBeInTheDocument();
  });

  it("lazily fetches the active artifact and renders it sandboxed", async () => {
    useSessionStore.getState().setSessionId("sess_1");
    mockContentFetch({ pres_one: "<h1>One</h1>" });
    usePresentStore.getState().hydrate([meta({ presentId: "pres_one", title: "One" })]);

    render(<PresentPane isActiveTab />);

    // Header is immediate; bytes arrive after the fetch resolves.
    expect(screen.getByText("One")).toBeInTheDocument();
    const iframe = await screen.findByTitle("Rendered content");
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    // The shared frame injects a best-effort CSP and wraps bare fragments, so
    // assert the content is present rather than an exact srcdoc (docs/219).
    const srcdoc = iframe.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("<h1>One</h1>");
    expect(srcdoc).toContain("connect-src 'none'");
    // Cached back onto the entry so re-selecting doesn't refetch.
    expect(usePresentStore.getState().presentations[0].content).toBe("<h1>One</h1>");
    expect(screen.queryByLabelText("Previous presentation")).toBeNull();
  });

  it("shows a fetch error and a recovery hint when content can't be loaded", async () => {
    useSessionStore.getState().setSessionId("sess_1");
    mockContentFetch({}); // every id 404s
    usePresentStore.getState().hydrate([meta({ presentId: "pres_gone", title: "Gone" })]);

    render(<PresentPane isActiveTab />);

    expect(await screen.findByText(/Presentation not found/)).toBeInTheDocument();
    expect(screen.getByText(/Ask the agent to present it again/)).toBeInTheDocument();
  });

  it("disables Download until the bytes have loaded", async () => {
    useSessionStore.getState().setSessionId("sess_1");
    mockContentFetch({ pres_one: "<h1>One</h1>" });
    usePresentStore.getState().hydrate([meta({ presentId: "pres_one", title: "One" })]);

    render(<PresentPane isActiveTab />);

    expect(screen.getByLabelText("Download presentation")).toBeDisabled();
    await screen.findByTitle("Rendered content");
    expect(screen.getByLabelText("Download presentation")).toBeEnabled();
  });

  it("shows the full file path beneath the title in the header", () => {
    usePresentStore.getState().hydrate([
      meta({ presentId: "pres_one", title: "Landing page", filePath: "docs/mockups/landing.html" }),
    ]);

    render(<PresentPane isActiveTab />);

    expect(screen.getByText("Landing page")).toBeInTheDocument();
    expect(screen.getByText("docs/mockups/landing.html")).toBeInTheDocument();
  });

  it("falls back to the file's basename as the heading when no title is given", () => {
    usePresentStore.getState().hydrate([
      meta({ presentId: "pres_one", filePath: "/tmp/sales-chart.html" }),
    ]);

    render(<PresentPane isActiveTab />);

    expect(screen.getByText("sales-chart.html")).toBeInTheDocument();
    expect(screen.getByText("/tmp/sales-chart.html")).toBeInTheDocument();
  });

  it("navigates presentations with buttons and arrow keys", () => {
    seedPresentations();
    render(<PresentPane isActiveTab />);

    expect(screen.getByText("1/2")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Next presentation"));
    expect(screen.getByText("2/2")).toBeInTheDocument();
    expect(usePresentStore.getState().activePresentIndex).toBe(1);

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(usePresentStore.getState().activePresentIndex).toBe(0);
  });

  it("ignores arrow keys originating from a text field (chat-typing must not move the carousel)", () => {
    // The keydown listener is on window and the chat composer is on screen at
    // the same time as the Present tab, so pressing ◀/▶ to move the text cursor
    // while typing must NOT step the carousel.
    seedPresentations();
    render(<PresentPane isActiveTab />);

    fireEvent.click(screen.getByLabelText("Next presentation"));
    expect(usePresentStore.getState().activePresentIndex).toBe(1);

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    fireEvent.keyDown(textarea, { key: "ArrowLeft" });
    expect(usePresentStore.getState().activePresentIndex).toBe(1); // unchanged
    textarea.remove();
  });

  it("toggles the thumbnail gallery from the header and closes it on tile select", () => {
    seedPresentations();
    render(<PresentPane isActiveTab />);

    fireEvent.click(screen.getByLabelText("View all presentations"));
    expect(usePresentStore.getState().galleryOpen).toBe(true);

    // Selecting a tile jumps to it and collapses back to the single view.
    fireEvent.click(screen.getByLabelText("View Two"));
    expect(usePresentStore.getState().galleryOpen).toBe(false);
    expect(usePresentStore.getState().activePresentIndex).toBe(1);
  });

  it("renders a markdown thumbnail (rendered prose, not the icon placeholder)", async () => {
    useSessionStore.getState().setSessionId("sess_1");
    mockContentFetch(
      { pres_one: "# Hello heading", pres_two: "# Other" },
      "text/markdown",
    );
    usePresentStore.getState().hydrate([
      meta({ presentId: "pres_one", title: "Doc", filePath: "/tmp/one.md", mimeType: "text/markdown" }),
      meta({ presentId: "pres_two", title: "Two", filePath: "/tmp/two.md", mimeType: "text/markdown" }),
    ]);
    render(<PresentPane isActiveTab />);

    fireEvent.click(screen.getByLabelText("View all presentations"));
    // The markdown renderer turns the source into prose — the heading text shows.
    expect(await screen.findByText("Hello heading")).toBeInTheDocument();
  });

  it("exposes no Save control — keeping an artifact is the agent's job", () => {
    seedPresentations();
    render(<PresentPane isActiveTab />);
    expect(screen.queryByLabelText("Save presentation to project")).toBeNull();
    // Download stays — it targets the user's local machine, not the workspace.
    expect(screen.getByLabelText("Download presentation")).toBeInTheDocument();
  });

  it("offers no way to destroy a presentation from the pane", () => {
    // The pane must never let the user delete an artifact: closing it would
    // leave the chat card's "View" button pointing at a presentation that no
    // longer exists, with no way to get it back. Navigating away from the
    // Present tab (desktop tabs / mobile tab bar) leaves the store intact.
    seedPresentations();
    render(<PresentPane isActiveTab />);
    expect(screen.queryByLabelText("Dismiss presentation")).not.toBeInTheDocument();
    expect(usePresentStore.getState().presentations.map((p) => p.presentId)).toEqual([
      "pres_one",
      "pres_two",
    ]);
  });
});

describe("mimeTypeToExtension", () => {
  it("maps known presentation mime types", () => {
    expect(mimeTypeToExtension("text/html")).toBe("html");
    expect(mimeTypeToExtension("image/svg+xml")).toBe("svg");
    expect(mimeTypeToExtension("text/markdown")).toBe("md");
    expect(mimeTypeToExtension("image/png")).toBe("png");
    expect(mimeTypeToExtension("image/jpeg")).toBe("jpg");
    expect(mimeTypeToExtension("image/gif")).toBe("gif");
  });

  it("is case-insensitive", () => {
    expect(mimeTypeToExtension("TEXT/HTML")).toBe("html");
  });

  it("falls back to txt for unknown types", () => {
    expect(mimeTypeToExtension("application/json")).toBe("txt");
  });
});

describe("suggestDownloadName", () => {
  it("slugifies the title and appends the mime extension", () => {
    expect(suggestDownloadName("Architecture Diagram", "image/svg+xml")).toBe(
      "architecture-diagram.svg",
    );
  });

  it("collapses runs of non-alphanumerics and trims edges", () => {
    expect(suggestDownloadName("  Sales Chart — v2!! ", "text/html")).toBe(
      "sales-chart-v2.html",
    );
  });

  it("falls back to 'presentation' when title is missing", () => {
    expect(suggestDownloadName(undefined, "text/markdown")).toBe("presentation.md");
  });

  it("falls back to 'presentation' when title slugifies to empty", () => {
    expect(suggestDownloadName("!!!", "image/png")).toBe("presentation.png");
  });

  it("has no directory prefix (unlike the workspace save path)", () => {
    expect(suggestDownloadName("Anything", "text/html")).not.toContain("/");
  });
});

describe("presentationToBlob", () => {
  it("wraps text content in a typed blob", async () => {
    const blob = presentationToBlob("<h1>hi</h1>", "text/html");
    expect(blob.type).toBe("text/html");
    expect(await blob.text()).toBe("<h1>hi</h1>");
  });

  it("defaults empty mime types to text/plain", () => {
    const blob = presentationToBlob("plain", "");
    expect(blob.type).toBe("text/plain");
  });

  it("decodes a base64 data URI back to its bytes", async () => {
    // "hello" base64-encoded.
    const blob = presentationToBlob("data:image/png;base64,aGVsbG8=", "image/png");
    expect(blob.type).toBe("image/png");
    expect(await blob.text()).toBe("hello");
  });

  it("decodes a URL-encoded (non-base64) data URI", async () => {
    const blob = presentationToBlob(
      "data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E",
      "image/svg+xml",
    );
    expect(blob.type).toBe("image/svg+xml");
    expect(await blob.text()).toBe("<svg></svg>");
  });
});

/**
 * docs/258 — a pointer addressing a place inside a presented artifact. Markdown
 * renders in ShipIt's own DOM, so the pane scrolls it itself; rendered HTML is
 * handled by a script injected into its `srcDoc` (see `RenderedFrame.test.tsx`).
 */
describe("PresentPane — agent-authored pointers", () => {
  const MD = "# First heading\n\nbody\n\n## Open questions?\n\nmore\n";

  /** Seed one markdown artifact, mock its bytes, and render the pane. */
  async function renderMarkdownArtifact() {
    useSessionStore.getState().setSessionId("sess-1");
    usePresentStore.getState().hydrate([
      meta({ presentId: "p1", filePath: "/persist/reqs.md", mimeType: "text/markdown" }),
    ]);
    mockContentFetch({ p1: MD }, "text/markdown");
    render(<PresentPane isActiveTab />);
    await screen.findByText("Open questions?");
  }

  it("scrolls to the heading a fragment names", async () => {
    await renderMarkdownArtifact();
    const scrollIntoView = vi.fn();
    for (const h of document.querySelectorAll("h1,h2")) {
      (h as HTMLElement).scrollIntoView = scrollIntoView;
    }

    // The slug contract the agent authors against: lowercase, punctuation
    // dropped, whitespace to hyphens.
    usePresentStore.getState().setLinkTarget({ presentId: "p1", fragment: "open-questions", clickId: 1 });
    await screen.findByText("Open questions?");
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("reports a fragment that matches no heading, naming it (req 10)", async () => {
    await renderMarkdownArtifact();
    usePresentStore.getState().setLinkTarget({ presentId: "p1", fragment: "nope", clickId: 2 });
    await vi.waitFor(() => expect(useUiStore.getState().toast?.message).toContain("nope"));
    expect(useUiStore.getState().toast?.variant).toBe("error");
  });

  it("reports the miss once, not again when the pane re-renders", async () => {
    await renderMarkdownArtifact();
    usePresentStore.getState().setLinkTarget({ presentId: "p1", fragment: "nope", clickId: 3 });
    await vi.waitFor(() => expect(useUiStore.getState().toast).not.toBeNull());
    useUiStore.setState({ toast: null });
    // A re-render (any store write the pane subscribes to) must not re-toast.
    usePresentStore.getState().markSeen();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("switches out of source view — a pointer addresses the rendered artifact", async () => {
    useSessionStore.getState().setSessionId("sess-1");
    usePresentStore.getState().hydrate([meta({ presentId: "p1", filePath: "/persist/a.html" })]);
    mockContentFetch({ p1: "<h1 id='top'>Hi</h1>" });
    render(<PresentPane isActiveTab />);
    await screen.findByTitle("Rendered content");

    fireEvent.click(screen.getByRole("button", { name: /source/i }));
    expect(screen.queryByTitle("Rendered content")).toBeNull();

    usePresentStore.getState().setLinkTarget({ presentId: "p1", fragment: "top", clickId: 4 });
    // Honouring the view mode would silently drop the request.
    await screen.findByTitle("Rendered content");
  });
});

describe("PresentPane — pointer lifecycle", () => {
  const html = (id: string) => `<html><body><h1 id="${id}">x</h1></body></html>`;

  it("does not blame a new artifact for the previous one's failed fetch", () => {
    // The fetch error is keyed to the artifact that produced it. Unkeyed, it
    // outlives that artifact for one render — long enough for the pointer
    // effect to toast about A while pointing at B, and mark B's click handled.
    useSessionStore.getState().setSessionId("sess-1");
    usePresentStore.getState().hydrate([
      meta({ presentId: "bad", filePath: "/persist/bad.html" }),
      meta({ presentId: "good", filePath: "/persist/good.html" }),
    ]);
    mockContentFetch({ good: html("top") }); // "bad" 404s
    render(<PresentPane isActiveTab />);

    return vi.waitFor(async () => {
      expect(useUiStore.getState().toast).toBeNull();
      usePresentStore.getState().focusByPath("/persist/good.html");
      usePresentStore.getState().setLinkTarget({ presentId: "good", fragment: "top", clickId: 9 });
      await screen.findByTitle("Rendered content");
      expect(useUiStore.getState().toast).toBeNull();
    });
  });

  it("releases a handled markdown target, so reopening the tab does not replay it", async () => {
    // `PresentPane` is only mounted while its tab is selected, so the local
    // "already handled" ref dies on every switch away.
    useSessionStore.getState().setSessionId("sess-1");
    usePresentStore.getState().hydrate([
      meta({ presentId: "p1", filePath: "/persist/a.md", mimeType: "text/markdown" }),
    ]);
    mockContentFetch({ p1: "# Only heading\n" }, "text/markdown");
    const view = render(<PresentPane isActiveTab />);
    await screen.findByText("Only heading");

    usePresentStore.getState().setLinkTarget({ presentId: "p1", fragment: "nope", clickId: 11 });
    await vi.waitFor(() => expect(useUiStore.getState().toast).not.toBeNull());
    expect(usePresentStore.getState().linkTarget).toBeNull();

    useUiStore.setState({ toast: null });
    view.unmount();
    render(<PresentPane isActiveTab />);
    await screen.findByText("Only heading");
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("keeps an HTML target, which is what the injected scroll is built from", async () => {
    // Clearing it would rebuild the `srcDoc` and remount the frame, undoing the
    // scroll it just performed.
    useSessionStore.getState().setSessionId("sess-1");
    usePresentStore.getState().hydrate([meta({ presentId: "p1", filePath: "/persist/a.html" })]);
    mockContentFetch({ p1: html("req-7") });
    render(<PresentPane isActiveTab />);
    await screen.findByTitle("Rendered content");

    usePresentStore.getState().setLinkTarget({ presentId: "p1", fragment: "req-7", clickId: 12 });
    await vi.waitFor(() => {
      expect(screen.getByTitle("Rendered content").getAttribute("srcdoc")).toContain("scrollIntoView");
    });
    expect(usePresentStore.getState().linkTarget).not.toBeNull();
  });
});
