/**
 * present-view — render a buffered `present` artifact into a servable HTTP
 * document so the agent's in-container browser can navigate to it and
 * screenshot the rendered result (docs/170).
 *
 * This is the serving half of docs/093's "Tier 2": the `present` MCP tool
 * stores bytes in {@link PresentBuffer}, and `GET /present-files/:presentId`
 * (session-worker.ts) hands them to this renderer. The agent then drives its
 * existing Playwright browser at `127.0.0.1:${WORKER_PORT}/present-files/...`
 * to *see* what it produced and iterate via `replaceId`.
 *
 * Everything is wrapped into an HTML document (except raw image bytes) so a
 * screenshot captures the full artifact edge-to-edge rather than a
 * default-sized element. The renderer is pure and async only because the
 * markdown path renders React to a static HTML string; it has no I/O and is
 * unit-tested in present-view.test.ts.
 *
 * Markdown is rendered with the SAME `react-markdown` + `remark-gfm` +
 * `remark-breaks` stack the user-facing Present tab uses
 * (`src/client/components/message-markdown.tsx`), via `react-dom/server`'s
 * `renderToStaticMarkup`. The only difference from the client is the
 * interactive code-block chrome (copy buttons, syntax highlighting) the client
 * layers on — none of which affects a screenshot. React + react-markdown are
 * imported lazily so the worker only pays for them when an artifact is markdown.
 */

import { createElement } from "react";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PresentBuffer, PresentEntry } from "./present-buffer.js";

export interface RenderedPresentDocument {
  contentType: string;
  body: string | Buffer;
}

const HEAD =
  "<!doctype html><html><head><meta charset=\"utf-8\">" +
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head>";

/** Minimal zero-margin HTML shell so screenshots capture the artifact fully. */
function htmlShell(inner: string): string {
  return `${HEAD}<body style="margin:0">${inner}</body></html>`;
}

/** Light styling for the markdown path so the rendered doc is legible. */
function markdownShell(inner: string): string {
  const style =
    "margin:0;padding:24px;max-width:760px;" +
    "font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
    "color:#111;background:#fff";
  return `${HEAD}<body style="${style}">${inner}</body></html>`;
}

/** Escape text destined for an HTML text node / wrapper. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render markdown to a static HTML string using the same `react-markdown` +
 * remark plugin stack as the client (message-markdown.tsx). Imports are lazy so
 * a worker that never serves a markdown artifact never loads React. `react`,
 * `react-dom`, and the remark plugins are all runtime dependencies, so they
 * survive `npm prune --omit=dev` into the session-worker image.
 */
async function renderMarkdownToHtml(markdown: string): Promise<string> {
  const [{ renderToStaticMarkup }, { default: Markdown }, { default: remarkGfm }, { default: remarkBreaks }] =
    await Promise.all([
      import("react-dom/server"),
      import("react-markdown"),
      import("remark-gfm"),
      import("remark-breaks"),
    ]);
  return renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm, remarkBreaks] }, markdown),
  );
}

/** Parse a `data:` URI into its mime and raw bytes. Returns null if malformed. */
function decodeDataUri(uri: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (!match) return null;
  const mime = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const data = match[3];
  const bytes = isBase64
    ? Buffer.from(data, "base64")
    : Buffer.from(decodeURIComponent(data), "utf8");
  return { mime, bytes };
}

/**
 * Render a buffered presentation into something the browser can display.
 *
 * - `text/html` — served as-is (matches the client's `srcdoc` content).
 * - `image/svg+xml` — bare SVG markup wrapped in a zero-margin HTML doc.
 * - `text/markdown` — converted to HTML with `marked`, wrapped + styled.
 * - `image/*` — a `data:` URI decoded to raw bytes served with its own mime;
 *   if it isn't a parseable data URI, the string is embedded in an `<img>`.
 * - anything else — embedded as escaped preformatted text.
 */
export async function renderPresentDocument(
  entry: PresentEntry,
): Promise<RenderedPresentDocument> {
  const mime = entry.mimeType.toLowerCase();

  if (mime === "text/html") {
    return { contentType: "text/html; charset=utf-8", body: entry.content };
  }

  if (mime === "image/svg+xml") {
    return {
      contentType: "text/html; charset=utf-8",
      body: htmlShell(entry.content),
    };
  }

  if (mime === "text/markdown") {
    return {
      contentType: "text/html; charset=utf-8",
      body: markdownShell(await renderMarkdownToHtml(entry.content)),
    };
  }

  if (mime.startsWith("image/")) {
    if (entry.content.startsWith("data:")) {
      const decoded = decodeDataUri(entry.content);
      if (decoded) {
        return { contentType: decoded.mime, body: decoded.bytes };
      }
    }
    // Not a parseable data URI — embed whatever we have as an image source.
    const src = escapeHtml(entry.content).replace(/"/g, "&quot;");
    return {
      contentType: "text/html; charset=utf-8",
      body: htmlShell(`<img src="${src}" style="display:block">`),
    };
  }

  // Unknown mime — show the raw content as preformatted, escaped text.
  return {
    contentType: "text/html; charset=utf-8",
    body: htmlShell(
      `<pre style="margin:0;padding:16px;white-space:pre-wrap;word-break:break-word">${escapeHtml(
        entry.content,
      )}</pre>`,
    ),
  };
}

/** Readable 404 body so the agent self-corrects rather than guessing. */
const EVICTED_404_BODY =
  "Presentation not found. It was evicted (the buffer keeps a bounded, " +
  "most-recent set) or never existed. Re-present the artifact to get a fresh URL.";

/**
 * Register the worker-local artifact-serving routes (docs/170).
 *
 * `GET /present-files/:presentId` (and the `/*` variant reserved for future
 * multi-file Tier 2 artifacts) reads the buffered entry and serves it via
 * {@link renderPresentDocument}. Worker-local by design: only the in-container
 * agent browser consumes this, so it deliberately does NOT route through the
 * orchestrator preview proxy. Extracted from `session-worker.ts` so the 404 /
 * serving behavior is unit-testable with `app.inject`.
 */
export function registerPresentFilesRoutes(
  app: FastifyInstance,
  buffer: PresentBuffer,
): void {
  const serve = async (
    request: { params: { presentId?: string } },
    reply: FastifyReply,
  ): Promise<unknown> => {
    const presentId = request.params.presentId ?? "";
    const entry = buffer.get(presentId);
    if (!entry) {
      return reply.code(404).type("text/plain; charset=utf-8").send(EVICTED_404_BODY);
    }
    const rendered = await renderPresentDocument(entry);
    return reply
      .header("Cache-Control", "no-store")
      .type(rendered.contentType)
      .send(rendered.body);
  };
  app.get<{ Params: { presentId?: string } }>("/present-files/:presentId", serve);
  app.get<{ Params: { presentId?: string } }>("/present-files/:presentId/*", serve);
}
