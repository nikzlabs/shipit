
import fsp from "node:fs/promises";
import { createElement } from "react";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PresentRegistry, PresentMeta } from "./present-registry.js";

export interface RenderedPresentDocument {
  contentType: string;
  body: string | Buffer;
}

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

export function isBinaryPresentMime(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return lower.startsWith("image/") && lower !== "image/svg+xml";
}

const HEAD =
  "<!doctype html><html><head><meta charset=\"utf-8\">" +
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head>";

function htmlShell(inner: string): string {
  return `${HEAD}<body style="margin:0">${inner}</body></html>`;
}

function markdownShell(inner: string): string {
  const style =
    "margin:0;padding:24px;max-width:760px;" +
    "font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
    "color:#111;background:#fff";
  return `${HEAD}<body style="${style}">${inner}</body></html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
    const src = escapeHtml(entry.content).replace(/"/g, "&quot;");
    return {
      contentType: "text/html; charset=utf-8",
      body: htmlShell(`<img src="${src}" style="display:block">`),
    };
  }

  return {
    contentType: "text/html; charset=utf-8",
    body: htmlShell(
      `<pre style="margin:0;padding:16px;white-space:pre-wrap;word-break:break-word">${escapeHtml(
        entry.content,
      )}</pre>`,
    ),
  };
}

const MISSING_404_BODY =
  "Presentation not found — the id is unknown or its file is no longer on " +
  "disk. Re-present the artifact to get a fresh URL.";

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

  // Restore metadata after worker restart; artifact bytes remain on disk.
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
