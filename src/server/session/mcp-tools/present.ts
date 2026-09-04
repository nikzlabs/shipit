/**
 * present tool — `present` (docs/093). Pure transport: POSTs the artifact PATH to
 * the worker's `/agent-ops/present/submit` broker, which records its metadata,
 * emits the `present_content` SSE event, and returns `{ presentId, viewUrl }`.
 * The broker's `presentId` is internal (derived from the path) — the agent never
 * passes it back, so the tool surfaces only `{ status, viewUrl }` to the agent.
 * Extracted from the former standalone `mcp-present-bridge.ts` for the
 * consolidated bridge; its server-level guidance becomes part of the merged
 * `shipit` server instructions.
 */

import type { ToolDescriptor } from "./types.js";

const TOOL_DESCRIPTION = [
  "Show the user one or more visual artifacts — diagrams, charts, graphs, mockups,",
  "wireframes, rendered markdown docs, comparison views, or HTML/SVG prototypes —",
  "rendered in ShipIt's dedicated Present tab, with no dev server. Reach for this",
  "proactively whenever you produce something visual for the user to look at,",
  "instead of only describing it in chat or writing a file you never surface.",
  "Multiple presentations coexist in the Present tab. Each call presents one file,",
  "so to show several artifacts at once (e.g. three design variants) write each",
  "file and call `present` once per file — they all stay visible together. Don't",
  "show one variant and point the user elsewhere for the rest; present them all.",
  "Identity is the file PATH: presenting a new path adds an entry, and presenting",
  "the SAME path again updates that entry in place (that's how you iterate — edit",
  "the file and re-present it, no version flag needed).",
  "Workflow: write a self-contained file with the Write tool, then call `present`",
  "with its path; repeat for each additional artifact.",
  "Write the file under /persist for a throwaway artifact (it never enters git but",
  "survives container restarts, so the user still sees it tomorrow), or into the",
  "workspace if you want it tracked and committed — either way it renders in the",
  "Present tab; the path's location is the only difference.",
  "The MIME type is inferred from the file extension (.html, .svg, .md, .png,",
  ".jpg, .gif, .webp); pass `mimeType` only to override it.",
  "Pass `inline: true` for something SMALL the user should see while reading the",
  "reply — a thumbnail, a small chart, a short rendered table, a compact HTML",
  "widget. It renders as a card in the conversation itself AND still appears in",
  "the Present tab. Everything else is identical: same file argument, same MIME",
  "inference, same path identity (re-presenting the same file inline updates the",
  "card already in the transcript rather than adding a second one). Leave it off",
  "for anything the user needs room to study — a full mockup, a large diagram, a",
  "long rendered doc — those belong in the Present tab alone.",
  "Returns `{ status, viewUrl }`. To verify how the artifact actually",
  "renders, navigate your browser to `viewUrl` and screenshot it — do NOT open",
  "the file directly, because `viewUrl` applies the same rendering the user",
  "sees (markdown→HTML, SVG/image wrapping) and the raw file does not. Then fix",
  "any layout/contrast/clipping defects, edit the file, and call `present` again",
  "with the same path to update it in place.",
  // The tool used to claim a ~1 MB cap that would reject larger artifacts. That
  // cap was the old `PresentBuffer`'s and it is gone (docs/093 — the registry
  // holds metadata only and reads bytes from disk on demand, so there is
  // nothing to cap; `present-registry.ts` says so at its top). A stated limit
  // that does not exist is the same defect as an enforced limit that is never
  // stated: it makes the model split or withhold an artifact for no reason.
  "Nothing is rejected for being big — there is no size cap. But keep an inline",
  "artifact small: the chat card is bounded in height, so a large one reads",
  "badly in a box. That is the reason to leave `inline` off, not a limit.",
  "Full guide (screenshot loop, MIME inference, limits): /shipit-docs/present.md.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    file: {
      type: "string",
      // The worker rejects an empty path (session-worker.ts). `required` does
      // not say that — an empty string satisfies `required` — so declare it.
      minLength: 1,
      description:
        "Path to the file to present. Relative paths resolve against the workspace; absolute paths (e.g. /persist/chart.html) are read as-is. Write the file first, then present it.",
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
    inline: {
      type: "boolean",
      description:
        "Also render the artifact as a card inside the chat conversation, not only in the Present tab. Use it for SMALL artifacts the user should see while reading the reply; leave it off for anything that needs room to study. The card is bounded in height and the artifact still appears in the Present tab. Defaults to false.",
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
  "it. Write a self-contained file (to /persist for a throwaway that still",
  "survives a restart, or into the workspace to keep it tracked), then call",
  "`present` with the file path. Each call presents one file and multiple",
  "presentations coexist in the tab, so to show several artifacts at once call",
  "`present` once per file. Add `inline: true` for a SMALL artifact the user",
  "should see while reading the reply — it renders as a card in the conversation",
  "itself and still appears in the Present tab.",
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
      inline?: boolean;
    };
    try {
      const res = await fetch(`${workerUrl}/agent-ops/present/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: a.file,
          mimeType: a.mimeType,
          title: a.title,
          inline: a.inline === true,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
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
      // The agent acts only on `viewUrl` (to screenshot the rendered artifact)
      // and re-presents by the same file PATH to update an entry — it never
      // passes an id back, so we don't echo `presentId` (it's internal).
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: body.status ?? "presented",
              ...(body.viewUrl !== undefined ? { viewUrl: body.viewUrl } : {}),
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
