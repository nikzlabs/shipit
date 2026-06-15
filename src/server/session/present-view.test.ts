import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  registerPresentFilesRoutes,
  renderPresentDocument,
  inferPresentMimeType,
  isBinaryPresentMime,
} from "./present-view.js";
import { PresentRegistry } from "./present-registry.js";

describe("inferPresentMimeType", () => {
  it.each([
    ["index.html", "text/html"],
    ["page.htm", "text/html"],
    ["diagram.svg", "image/svg+xml"],
    ["notes.md", "text/markdown"],
    ["notes.markdown", "text/markdown"],
    ["shot.png", "image/png"],
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["anim.gif", "image/gif"],
    ["pic.webp", "image/webp"],
    ["log.txt", "text/plain"],
  ])("maps %s → %s", (file, mime) => {
    expect(inferPresentMimeType(file)).toBe(mime);
  });

  it("is case-insensitive on the extension", () => {
    expect(inferPresentMimeType("/tmp/CHART.HTML")).toBe("text/html");
  });

  it("resolves the extension from a full path", () => {
    expect(inferPresentMimeType("/workspace/docs/mockups/landing.svg")).toBe("image/svg+xml");
  });

  it("returns empty string for unknown or missing extensions", () => {
    expect(inferPresentMimeType("README")).toBe("");
    expect(inferPresentMimeType("archive.tar.zip")).toBe("");
  });
});

describe("isBinaryPresentMime", () => {
  it("treats raster image types as binary", () => {
    expect(isBinaryPresentMime("image/png")).toBe(true);
    expect(isBinaryPresentMime("image/jpeg")).toBe(true);
    expect(isBinaryPresentMime("IMAGE/GIF")).toBe(true);
  });

  it("treats SVG and text types as non-binary", () => {
    expect(isBinaryPresentMime("image/svg+xml")).toBe(false);
    expect(isBinaryPresentMime("text/html")).toBe(false);
    expect(isBinaryPresentMime("text/markdown")).toBe(false);
  });
});

describe("renderPresentDocument", () => {
  it("serves text/html content verbatim", async () => {
    const html = "<!doctype html><html><body><h1>hi</h1></body></html>";
    const out = await renderPresentDocument({ content: html, mimeType: "text/html" });
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.body).toBe(html);
  });

  it("wraps bare SVG markup in a zero-margin HTML document", async () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><rect/></svg>";
    const out = await renderPresentDocument({ content: svg, mimeType: "image/svg+xml" });
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.body).toContain("margin:0");
    expect(out.body).toContain(svg);
  });

  it("renders markdown to HTML", async () => {
    const out = await renderPresentDocument({ content: "# Title\n\n- one\n- two", mimeType: "text/markdown" });
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.body).toContain("<h1");
    expect(out.body).toContain("Title");
    expect(out.body).toContain("<li>one</li>");
  });

  it("decodes a base64 image data URI to raw bytes with its own mime", async () => {
    // 1x1 transparent PNG.
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const out = await renderPresentDocument({ content: `data:image/png;base64,${b64}`, mimeType: "image/png" });
    expect(out.contentType).toBe("image/png");
    expect(Buffer.isBuffer(out.body)).toBe(true);
    expect((out.body as Buffer).equals(Buffer.from(b64, "base64"))).toBe(true);
  });

  it("embeds a non-data-URI image string in an <img> wrapper", async () => {
    const out = await renderPresentDocument({ content: "https://example.com/x.png", mimeType: "image/png" });
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.body).toContain("<img src=\"https://example.com/x.png\"");
  });

  it("falls back to escaped preformatted text for unknown mimes", async () => {
    const out = await renderPresentDocument({ content: "<not> & html", mimeType: "text/plain" });
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.body).toContain("&lt;not&gt; &amp; html");
  });
});

describe("registerPresentFilesRoutes", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "present-view-"));
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Write an artifact to disk and register its metadata, returning the registry. */
  async function seed(presentId: string, body: string, mimeType: string): Promise<PresentRegistry> {
    const registry = new PresentRegistry();
    const filePath = path.join(tmpDir, presentId);
    await writeFile(filePath, body, "utf8");
    registry.put(presentId, {
      resolvedPath: filePath,
      filePath,
      mimeType,
      createdAt: "2026-06-03T00:00:00.000Z",
    });
    return registry;
  }

  async function buildApp(registry: PresentRegistry) {
    const app = Fastify();
    registerPresentFilesRoutes(app, registry);
    await app.ready();
    return app;
  }

  it("reads an HTML artifact from disk and serves it rendered with no-store", async () => {
    const app = await buildApp(await seed("pres_html", "<h1>hello</h1>", "text/html"));
    try {
      const res = await app.inject({ method: "GET", url: "/present-files/pres_html" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toBe("<h1>hello</h1>");
    } finally {
      await app.close();
    }
  });

  it("returns a readable 404 when the presentId is absent (gone/never existed)", async () => {
    const app = await buildApp(new PresentRegistry());
    try {
      const res = await app.inject({ method: "GET", url: "/present-files/pres_missing" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.body).toContain("Re-present the artifact");
    } finally {
      await app.close();
    }
  });

  it("serves the same entry through the multi-file wildcard variant", async () => {
    const app = await buildApp(
      await seed("pres_svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>", "image/svg+xml"),
    );
    try {
      const res = await app.inject({ method: "GET", url: "/present-files/pres_svg/index.html" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("<svg");
    } finally {
      await app.close();
    }
  });

  it("serves raw content + mime as JSON for the Present tab", async () => {
    const app = await buildApp(await seed("pres_raw", "# Heading", "text/markdown"));
    try {
      const res = await app.inject({ method: "GET", url: "/present/pres_raw/raw" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = res.json() as { content: string; mimeType: string };
      expect(body.content).toBe("# Heading"); // raw markdown, NOT rendered HTML
      expect(body.mimeType).toBe("text/markdown");
    } finally {
      await app.close();
    }
  });

  it("404s the raw route for an unknown presentId", async () => {
    const app = await buildApp(new PresentRegistry());
    try {
      const res = await app.inject({ method: "GET", url: "/present/pres_missing/raw" });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toMatch(/not found/i);
    } finally {
      await app.close();
    }
  });

  // docs/093 — re-register a presentation into a fresh worker's registry after a
  // container restart, then serve its bytes from the persisted path.
  it("registers a presentation and then serves its raw bytes", async () => {
    const filePath = path.join(tmpDir, "reregister.html");
    await writeFile(filePath, "<h1>restored</h1>", "utf8");
    const app = await buildApp(new PresentRegistry());
    try {
      // Empty registry → raw read misses first.
      expect((await app.inject({ method: "GET", url: "/present/pres_re/raw" })).statusCode).toBe(404);

      const reg = await app.inject({
        method: "POST",
        url: "/present/register",
        payload: {
          presentId: "pres_re",
          resolvedPath: filePath,
          filePath: "docs/x.html",
          mimeType: "text/html",
          createdAt: "2026-06-15T00:00:00.000Z",
          title: "Restored",
        },
      });
      expect(reg.statusCode).toBe(200);
      expect((reg.json() as { ok: boolean }).ok).toBe(true);

      const res = await app.inject({ method: "GET", url: "/present/pres_re/raw" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { content: string; mimeType: string; title?: string };
      expect(body.content).toBe("<h1>restored</h1>");
      expect(body.mimeType).toBe("text/html");
      expect(body.title).toBe("Restored");
    } finally {
      await app.close();
    }
  });

  it("rejects a register call missing required fields", async () => {
    const app = await buildApp(new PresentRegistry());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/present/register",
        payload: { presentId: "pres_x" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("404s after register when the persisted file is gone from disk", async () => {
    const app = await buildApp(new PresentRegistry());
    try {
      const reg = await app.inject({
        method: "POST",
        url: "/present/register",
        payload: {
          presentId: "pres_gone",
          resolvedPath: path.join(tmpDir, "never-written.html"),
          filePath: "/tmp/never-written.html",
          mimeType: "text/html",
          createdAt: "2026-06-15T00:00:00.000Z",
        },
      });
      expect(reg.statusCode).toBe(200);
      // Registration succeeds, but the on-disk read fails → graceful 404.
      const res = await app.inject({ method: "GET", url: "/present/pres_gone/raw" });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toMatch(/no longer on disk/i);
    } finally {
      await app.close();
    }
  });
});
