import { describe, it, expect } from "vitest";
import {
  kindFromPreviewType,
  kindFromMimeType,
  supportsSourceToggle,
  supportsKindReview,
  isRepoReviewablePath,
} from "./file-content-kind.js";

describe("kindFromPreviewType", () => {
  it("splits .svg out of the image bucket", () => {
    expect(kindFromPreviewType("image", "docs/mockup.svg")).toBe("svg");
  });
  it("keeps raster images as image", () => {
    expect(kindFromPreviewType("image", "docs/shot.png")).toBe("image");
  });
  it("splits .html/.htm out of the code bucket", () => {
    expect(kindFromPreviewType("code", "docs/mockup.html")).toBe("html");
    expect(kindFromPreviewType("code", "docs/mockup.htm")).toBe("html");
  });
  it("passes markdown and binary through", () => {
    expect(kindFromPreviewType("markdown", "docs/plan.md")).toBe("markdown");
    expect(kindFromPreviewType("binary", "blob.bin")).toBe("binary");
  });
  it("leaves ordinary code as code", () => {
    expect(kindFromPreviewType("code", "src/app.ts")).toBe("code");
  });
});

describe("kindFromMimeType", () => {
  it("maps the known present MIME types", () => {
    expect(kindFromMimeType("text/html", "x")).toBe("html");
    expect(kindFromMimeType("image/svg+xml", "x")).toBe("svg");
    expect(kindFromMimeType("text/markdown", "x")).toBe("markdown");
    expect(kindFromMimeType("image/png", "x")).toBe("image");
  });
  it("tolerates a charset suffix", () => {
    expect(kindFromMimeType("text/html; charset=utf-8", "x")).toBe("html");
  });
  it("falls back to the extension for odd/missing MIME", () => {
    expect(kindFromMimeType("", "a.html")).toBe("html");
    expect(kindFromMimeType("application/octet-stream", "a.svg")).toBe("svg");
    expect(kindFromMimeType("", "a.md")).toBe("markdown");
    expect(kindFromMimeType("", "a.ts")).toBe("code");
  });
});

describe("supportsSourceToggle", () => {
  it("is true only for html and svg", () => {
    expect(supportsSourceToggle("html")).toBe(true);
    expect(supportsSourceToggle("svg")).toBe(true);
    expect(supportsSourceToggle("markdown")).toBe(false);
    expect(supportsSourceToggle("code")).toBe(false);
    expect(supportsSourceToggle("image")).toBe(false);
  });
});

describe("supportsKindReview", () => {
  it("covers markdown/code/html/svg, excludes image/binary", () => {
    expect(supportsKindReview("markdown")).toBe(true);
    expect(supportsKindReview("code")).toBe(true);
    expect(supportsKindReview("html")).toBe(true);
    expect(supportsKindReview("svg")).toBe(true);
    expect(supportsKindReview("image")).toBe(false);
    expect(supportsKindReview("binary")).toBe(false);
  });
});

describe("isRepoReviewablePath", () => {
  it("accepts workspace-relative paths", () => {
    expect(isRepoReviewablePath("docs/x.html")).toBe(true);
    expect(isRepoReviewablePath("src/a/b.ts")).toBe(true);
  });
  it("rejects absolute paths (incl. /persist and /tmp)", () => {
    expect(isRepoReviewablePath("/persist/x.html")).toBe(false);
    expect(isRepoReviewablePath("/tmp/x.html")).toBe(false);
    expect(isRepoReviewablePath("/anything")).toBe(false);
  });
  it("rejects traversal", () => {
    expect(isRepoReviewablePath("../escape.md")).toBe(false);
    expect(isRepoReviewablePath("docs/../../etc/passwd")).toBe(false);
  });
  it("rejects empty", () => {
    expect(isRepoReviewablePath("")).toBe(false);
  });
});
