/**
 * present-view — read a `present` artifact from disk and serve it, either
 * rendered into a servable HTML document (for the agent's in-container browser
 * to screenshot, docs/170) or raw (for the user's Present tab, docs/093).
 *
 * The `present` MCP tool records only a path in {@link PresentRegistry}; these
 * routes read the bytes from disk on demand — nothing is retained. The agent
 * drives its Playwright browser at `127.0.0.1:${WORKER_PORT}/present-files/...`
 * to *see* what it produced and iterate by re-presenting the same file (its
 * `presentId` is content-addressed by path, so the entry updates in place).
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

import fsp from "node:fs/promises";
import { createElement } from "react";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PresentRegistry, PresentMeta } from "./present-registry.js";

export interface RenderedPresentDocument {
  contentType: string;
  body: string | Buffer;
}

/**
 * Infer a presentation MIME type from a file's extension (docs/188). The
 * `present` tool is file-based — the agent writes a file and presents it by
 * path — so the worker derives the MIME from the extension rather than asking
 * the agent to pass one. Returns `""` for unrecognized extensions; the caller
 * falls back to `text/plain` (which renders as escaped preformatted text).
 *
 * Kept in sync with the renderer below and the client's `PresentationContent`
 * branch list: html/svg/markdown render rich, image/* serve as bytes, anything
 * else is plain text.
 */
export function inferPresentMimeType(filePath: string): string {
  const ext = /\.([a-z0-9]+)$/.exec(filePath.toLowerCase())?.[1];
  switch (ext) {
    case "html":
    case "htm":
      return "text/html";
    case "svg":
      return "image/svg+xml";
    case "md":
    case "markdown":
      return "text/markdown";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "txt":
    case "text":
      return "text/plain";
    default:
      return "";
  }
}

/**
 * True when a presentation of this MIME type is binary and must be read from
 * disk as raw bytes (then encoded as a `data:` URI for the buffer/WS pipeline).
 * SVG is excluded — it is XML markup served and rendered as text.
 */
export function isBinaryPresentMime(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return lower.startsWith("image/") && lower !== "image/svg+xml";
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
  entry: { content: string; mimeType: string },
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
const MISSING_404_BODY =
  "Presentation not found — the id is unknown or its file is no longer on " +
  "disk. Re-present the artifact to get a fresh URL.";

/**
 * Read an artifact's bytes from disk into the `content` string the present
 * pipeline carries: binary images become a `data:` base64 URI, everything else
 * (HTML/SVG markup, markdown, plain text) is read as UTF-8. Lazy by design —
 * nothing is cached, so the read reflects the file's current contents.
 */
export async function readArtifactContent(
  meta: PresentMeta,
): Promise<{ content: string; mimeType: string; title?: string }> {
  const content = isBinaryPresentMime(meta.mimeType)
    ? `data:${meta.mimeType};base64,${(await fsp.readFile(meta.resolvedPath)).toString("base64")}`
    : await fsp.readFile(meta.resolvedPath, "utf8");
  return {
    content,
    mimeType: meta.mimeType,
    ...(meta.title !== undefined ? { title: meta.title } : {}),
  };
}

/**
 * Register the artifact-serving routes (docs/170, docs/093).
 *
 * Both routes resolve a `presentId` to its on-disk path via the
 * {@link PresentRegistry} and read the bytes fresh — the worker never retains
 * artifact content.
 *
 *  - `GET /present-files/:presentId` (+ `/*`) — RENDERED into a servable HTML
 *    document for the agent's in-container Playwright browser to screenshot and
 *    iterate (docs/170). Worker-local by design: only `127.0.0.1:${WORKER_PORT}`
 *    reaches it, so it does NOT route through the orchestrator preview proxy.
 *  - `GET /present/:presentId/raw` — the RAW `content`+`mimeType` as JSON, for
 *    the user's Present tab to render. Reached only through the orchestrator's
 *    authenticated session API (never the public preview proxy), so artifacts
 *    stay off any routable URL while the browser still renders byte-for-byte.
 *
 * Extracted from `session-worker.ts` so the 404 / serving behavior is
 * unit-testable with `app.inject`.
 */
export function registerPresentFilesRoutes(
  app: FastifyInstance,
  registry: PresentRegistry,
): void {
  const serveRendered = async (
    request: { params: { presentId?: string } },
    reply: FastifyReply,
  ): Promise<unknown> => {
    const meta = registry.get(request.params.presentId ?? "");
    if (!meta) {
      return reply.code(404).type("text/plain; charset=utf-8").send(MISSING_404_BODY);
    }
    let artifact: { content: string; mimeType: string };
    try {
      artifact = await readArtifactContent(meta);
    } catch {
      return reply.code(404).type("text/plain; charset=utf-8").send(MISSING_404_BODY);
    }
    const rendered = await renderPresentDocument(artifact);
    return reply
      .header("Cache-Control", "no-store")
      .type(rendered.contentType)
      .send(rendered.body);
  };
  app.get<{ Params: { presentId?: string } }>("/present-files/:presentId", serveRendered);
  app.get<{ Params: { presentId?: string } }>("/present-files/:presentId/*", serveRendered);

  app.get<{ Params: { presentId?: string } }>(
    "/present/:presentId/raw",
    async (request, reply): Promise<unknown> => {
      const meta = registry.get(request.params.presentId ?? "");
      if (!meta) {
        return reply.code(404).send({ error: "Presentation not found" });
      }
      let artifact: { content: string; mimeType: string; title?: string };
      try {
        artifact = await readArtifactContent(meta);
      } catch {
        return reply.code(404).send({ error: "Presentation file is no longer on disk" });
      }
      return reply.header("Cache-Control", "no-store").send(artifact);
    },
  );

  // docs/093 — rehydrate a presentation's metadata into THIS worker's registry.
  // After a container restart the worker is fresh and its registry is empty, but
  // the orchestrator still holds the durable metadata (incl. `resolvedPath`). On
  // the first `/present/:id/raw` miss it re-registers the artifact here, then
  // re-reads the bytes from disk — so a workspace-committed artifact re-renders
  // after a restart. Bytes are never sent; only the path + metadata. Idempotent.
  app.post<{
    Body: {
      presentId?: string;
      resolvedPath?: string;
      filePath?: string;
      mimeType?: string;
      title?: string;
      createdAt?: string;
    };
  }>("/present/register", async (request, reply): Promise<unknown> => {
    const { presentId, resolvedPath, filePath, mimeType, title, createdAt } = request.body ?? {};
    if (
      typeof presentId !== "string" || presentId.length === 0
      || typeof resolvedPath !== "string" || resolvedPath.length === 0
      || typeof filePath !== "string" || filePath.length === 0
      || typeof mimeType !== "string" || mimeType.length === 0
    ) {
      return reply.code(400).send({
        error: "presentId, resolvedPath, filePath and mimeType are required",
      });
    }
    registry.put(presentId, {
      resolvedPath,
      filePath,
      mimeType,
      createdAt: typeof createdAt === "string" && createdAt.length > 0 ? createdAt : new Date().toISOString(),
      ...(typeof title === "string" && title.length > 0 ? { title } : {}),
    });
    return reply.send({ ok: true });
  });
}
