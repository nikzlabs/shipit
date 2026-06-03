import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPresentFilesRoutes, renderPresentDocument } from "./present-view.js";
import { PresentBuffer, type PresentEntry } from "./present-buffer.js";

function entry(partial: Partial<PresentEntry> & { content: string; mimeType: string }): PresentEntry {
  return {
    title: undefined,
    createdAt: "2026-06-03T00:00:00.000Z",
    byteSize: Buffer.byteLength(partial.content, "utf8"),
    ...partial,
  };
}

describe("renderPresentDocument", () => {
  it("serves text/html content verbatim", async () => {
    const html = "<!doctype html><html><body><h1>hi</h1></body></html>";
    const out = await renderPresentDocument(entry({ content: html, mimeType: "text/html" }));
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.body).toBe(html);
  });

  it("wraps bare SVG markup in a zero-margin HTML document", async () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><rect/></svg>";
    const out = await renderPresentDocument(entry({ content: svg, mimeType: "image/svg+xml" }));
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.body).toContain("margin:0");
    expect(out.body).toContain(svg);
  });

  it("renders markdown to HTML", async () => {
    const out = await renderPresentDocument(
      entry({ content: "# Title\n\n- one\n- two", mimeType: "text/markdown" }),
    );
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.body).toContain("<h1");
    expect(out.body).toContain("Title");
    expect(out.body).toContain("<li>one</li>");
  });

  it("decodes a base64 image data URI to raw bytes with its own mime", async () => {
    // 1x1 transparent PNG.
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const out = await renderPresentDocument(
      entry({ content: `data:image/png;base64,${b64}`, mimeType: "image/png" }),
    );
    expect(out.contentType).toBe("image/png");
    expect(Buffer.isBuffer(out.body)).toBe(true);
    expect((out.body as Buffer).equals(Buffer.from(b64, "base64"))).toBe(true);
  });

  it("embeds a non-data-URI image string in an <img> wrapper", async () => {
    const out = await renderPresentDocument(
      entry({ content: "https://example.com/x.png", mimeType: "image/png" }),
    );
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.body).toContain("<img src=\"https://example.com/x.png\"");
  });

  it("falls back to escaped preformatted text for unknown mimes", async () => {
    const out = await renderPresentDocument(
      entry({ content: "<not> & html", mimeType: "text/plain" }),
    );
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.body).toContain("&lt;not&gt; &amp; html");
  });
});

describe("registerPresentFilesRoutes", () => {
  async function buildApp(buffer: PresentBuffer) {
    const app = Fastify();
    registerPresentFilesRoutes(app, buffer);
    await app.ready();
    return app;
  }

  it("serves a buffered HTML entry with no-store and the right content type", async () => {
    const buffer = new PresentBuffer();
    buffer.put("pres_html", { content: "<h1>hello</h1>", mimeType: "text/html" });
    const app = await buildApp(buffer);
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

  it("returns a readable 404 when the presentId is absent (evicted/never existed)", async () => {
    const app = await buildApp(new PresentBuffer());
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
    const buffer = new PresentBuffer();
    buffer.put("pres_svg", {
      content: "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
      mimeType: "image/svg+xml",
    });
    const app = await buildApp(buffer);
    try {
      const res = await app.inject({ method: "GET", url: "/present-files/pres_svg/index.html" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("<svg");
    } finally {
      await app.close();
    }
  });
});
