import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  PresentPane,
  mimeTypeToExtension,
  suggestDownloadName,
  presentationToBlob,
} from "./PresentPane.js";
import { usePresentStore } from "../stores/present-store.js";
import { useSessionStore } from "../stores/session-store.js";

function seedPresentations() {
  usePresentStore.getState().hydrate([
    {
      presentId: "pres_one",
      content: "<h1>One</h1>",
      mimeType: "text/html",
      title: "One",
      createdAt: "2026-05-31T00:00:00.000Z",
    },
    {
      presentId: "pres_two",
      content: "<h1>Two</h1>",
      mimeType: "text/html",
      title: "Two",
      createdAt: "2026-05-31T00:00:01.000Z",
    },
  ]);
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

  it("hides carousel controls for a single presentation and sandboxes HTML", () => {
    usePresentStore.getState().hydrate([
      {
        presentId: "pres_one",
        content: "<h1>One</h1>",
        mimeType: "text/html",
        title: "One",
        createdAt: "2026-05-31T00:00:00.000Z",
      },
    ]);

    render(<PresentPane isActiveTab />);

    expect(screen.getByText("One")).toBeInTheDocument();
    expect(screen.queryByLabelText("Previous presentation")).toBeNull();
    const iframe = screen.getByTitle("Presentation");
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
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

  it("posts the selected presentation id and workspace path when saving", async () => {
    seedPresentations();
    useSessionStore.getState().setSessionId("sess_123");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    render(<PresentPane isActiveTab />);
    fireEvent.click(screen.getByLabelText("Save presentation to project"));
    fireEvent.change(screen.getByLabelText("Workspace path"), {
      target: { value: "docs/chart.html" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/sess_123/present/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presentId: "pres_one", destPath: "docs/chart.html" }),
      });
    });
  });

  it("dismisses the active presentation", () => {
    seedPresentations();
    render(<PresentPane isActiveTab />);
    fireEvent.click(screen.getByLabelText("Dismiss presentation"));
    expect(usePresentStore.getState().presentations.map((p) => p.presentId)).toEqual(["pres_two"]);
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
