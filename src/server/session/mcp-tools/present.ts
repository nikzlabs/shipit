/**
 * present tool — `present` (docs/093). Pure transport: POSTs the artifact to the
 * worker's `/agent-ops/present/submit` broker, which persists the bytes, emits
 * the `present_content` SSE event, and returns `{ presentId, viewUrl }`.
 * Extracted from the former standalone `mcp-present-bridge.ts` for the
 * consolidated bridge; its server-level guidance becomes part of the merged
 * `shipit` server instructions.
 */

import type { ToolDescriptor } from "./types.js";

const TOOL_DESCRIPTION = [
  "Show the user a visual artifact — a diagram, chart, graph, mockup, wireframe,",
  "rendered markdown doc, comparison view, or HTML/SVG prototype — rendered in",
  "ShipIt's dedicated Present tab, with no dev server. Reach for this proactively",
  "whenever you produce something visual for the user to look at, instead of only",
  "describing it in chat or writing a file you never surface.",
  "Workflow: write a single self-contained file with the Write tool, then call",
  "`present` with its path.",
  "Write the file under /tmp for a throwaway artifact (it never enters git), or",
  "into the workspace if you want it tracked and committed — either way it renders",
  "in the Present tab; the path's location is the only difference.",
  "The MIME type is inferred from the file extension (.html, .svg, .md, .png,",
  ".jpg, .gif, .webp); pass `mimeType` only to override it.",
  "Pass `replaceId` with a prior call's `presentId` to revise an existing",
  "presentation in-place (e.g. mockup v1 → v2) — edit the file and call again;",
  "omit it for a brand-new entry.",
  "Returns `{ presentId, viewUrl }`. To verify how the artifact actually",
  "renders, navigate your browser to `viewUrl` and screenshot it — do NOT open",
  "the file directly, because `viewUrl` applies the same rendering the user",
  "sees (markdown→HTML, SVG/image wrapping) and the raw file does not. Then fix",
  "any layout/contrast/clipping defects, edit the file, and call `present` again",
  "with `replaceId` set to the same `presentId` to revise in place.",
  "The file is capped at ~1 MB; larger artifacts will be rejected.",
  "Full guide (screenshot loop, MIME inference, limits): /shipit-docs/present.md.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    file: {
      type: "string",
      description:
        "Path to the file to present. Relative paths resolve against the workspace; absolute paths (e.g. /tmp/chart.html) are read as-is. Write the file first, then present it.",
    },
    mimeType: {
      type: "string",
      description:
        "Optional override for the MIME type. By default it is inferred from the file extension ('text/html', 'image/svg+xml', 'text/markdown', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'). Unknown extensions fall back to 'text/plain'.",
    },
    title: {
      type: "string",
      description:
        "Short human-friendly name for the artifact, shown as the heading in the Present tab above the file path (e.g. 'Architecture Diagram', 'Sales Chart v2'). Optional — without it the header falls back to the file's name.",
    },
    replaceId: {
      type: "string",
      description:
        "When set to a previous call's `presentId`, replaces that entry in-place (revision flow). Omit to append a new entry.",
    },
  },
  required: ["file"],
};

// Server-level guidance. Both Claude Code's tool search and Codex's BM25 tool
// index rank/surface deferred MCP tools using the server's instructions, so this
// is what helps either agent reach for `present` when it produces something
// visual. Kept concise (Claude truncates instructions at ~2 KB). See docs/188.
const INSTRUCTIONS = [
  "Use the `present` tool to show the user a visual artifact in ShipIt's Present",
  "tab without a dev server: a diagram, chart, graph, mockup, wireframe, rendered",
  "markdown doc, comparison view, or HTML/SVG prototype. Reach for it whenever you",
  "create something visual for the user to look at, rather than only describing",
  "it. Write a single self-contained file (to /tmp for a throwaway, or into the",
  "workspace to keep it tracked), then call `present` with the file path.",
].join(" ");

export const presentTool: ToolDescriptor = {
  id: "present",
  name: "present",
  description: TOOL_DESCRIPTION,
  inputSchema,
  instructions: INSTRUCTIONS,
  async call(args, { workerUrl }) {
    const a = args as {
      file?: string;
      mimeType?: string;
      title?: string;
      replaceId?: string;
    };
    try {
      const res = await fetch(`${workerUrl}/agent-ops/present/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: a.file,
          mimeType: a.mimeType,
          title: a.title,
          replaceId: a.replaceId,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        presentId?: string;
        status?: string;
        viewUrl?: string;
      };
      if (!res.ok) {
        const reason = body.error || `present service returned HTTP ${res.status}`;
        return {
          content: [{ type: "text", text: `present failed: ${reason}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: body.status ?? "presented",
              presentId: body.presentId,
              ...(body.viewUrl !== undefined ? { viewUrl: body.viewUrl } : {}),
              ...(a.title !== undefined ? { title: a.title } : {}),
              ...(a.replaceId !== undefined ? { replaceId: a.replaceId } : {}),
            }),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `present could not reach the worker: ${message}` }],
        isError: true,
      };
    }
  },
};
