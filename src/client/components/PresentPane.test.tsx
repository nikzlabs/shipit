import { describe, it, expect } from "vitest";
import {
  mimeTypeToExtension,
  suggestDownloadName,
  presentationToBlob,
} from "./PresentPane.js";

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
