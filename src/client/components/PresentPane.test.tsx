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
