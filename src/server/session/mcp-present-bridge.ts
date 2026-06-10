/**
 * mcp-present-bridge — stdio MCP server that exposes the `present` tool to the
 * agent CLI and forwards each call to the session worker (docs/093).
 *
 * Pure transport: no state, no validation, no business logic. The agent CLI
 * spawns this as a subprocess (declared in the per-agent MCP config the worker
 * generates), talks MCP over stdio, and this bridge POSTs each tool call to
 * the worker's `/agent-ops/present/submit` broker on localhost. The worker
 * persists the bytes in its in-memory buffer, emits the `present_content` SSE
 * event, and returns `{ presentId }` — which we relay back through the MCP
 * transport as the tool result.
 *
 * Mirrors the same pattern as `mcp-review-bridge.ts` (docs/125). The bridge
 * exists because the CLI's MCP transport is stdio-over-subprocess; it cannot
 * call an in-process handler. When the worker is down, the fetch fails and the
 * tool surfaces a clear error rather than hanging.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAME = "present";

const WORKER_URL = `http://127.0.0.1:${process.env.WORKER_PORT || "9100"}`;

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
        "Short display title shown in the carousel header (e.g. 'Architecture Diagram', 'Sales Chart v2'). Optional.",
    },
    replaceId: {
      type: "string",
      description:
        "When set to a previous call's `presentId`, replaces that entry in-place (revision flow). Omit to append a new entry.",
    },
  },
  required: ["file"],
};

// MCP server instructions. Both Claude Code's tool search and Codex's BM25 tool
// index rank/surface deferred MCP tools using the server's instructions (not
// just the per-tool description), so this is what helps either agent decide to
// reach for `present` when it has produced something visual. Kept concise
// (Claude truncates instructions at ~2 KB). See docs/188.
const SERVER_INSTRUCTIONS = [
  "Use this server's `present` tool to show the user a visual artifact in",
  "ShipIt's Present tab without a dev server: a diagram, chart, graph, mockup,",
  "wireframe, rendered markdown doc, comparison view, or HTML/SVG prototype.",
  "Reach for it whenever you create something visual for the user to look at,",
  "rather than only describing it. Write a single self-contained file (to /tmp",
  "for a throwaway, or into the workspace to keep it tracked), then call",
  "`present` with the file path.",
].join(" ");

/**
 * Build the MCP `Server` with the `present` tool's `ListTools` / `CallTool`
 * handlers wired. Factored out of the module top-level so tests can connect it
 * to an in-process transport pair without spawning stdio (the live entry point
 * below still connects a `StdioServerTransport`). Pure construction — no I/O
 * happens until the returned server is connected to a transport.
 */
export function createPresentBridgeServer() {
  // Use the low-level Server (not McpServer) so we can pass a plain JSON Schema
  // rather than a zod schema — keeps zod transitive instead of a direct dep on
  // both runtimes. Mirrors the rationale documented in mcp-review-bridge.ts.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: "shipit-present", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema }],
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== TOOL_NAME) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }

    const args = (req.params.arguments ?? {}) as {
      file?: string;
      mimeType?: string;
      title?: string;
      replaceId?: string;
    };

    try {
      const res = await fetch(`${WORKER_URL}/agent-ops/present/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: args.file,
          mimeType: args.mimeType,
          title: args.title,
          replaceId: args.replaceId,
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
          content: [{ type: "text" as const, text: `present failed: ${reason}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: body.status ?? "presented",
              presentId: body.presentId,
              ...(body.viewUrl !== undefined ? { viewUrl: body.viewUrl } : {}),
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.replaceId !== undefined ? { replaceId: args.replaceId } : {}),
            }),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `present could not reach the worker: ${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// Connect over stdio only when run as the entry point (the agent CLI spawns
// this file directly via `tsx`). Importing the module — e.g. from a test —
// must NOT touch stdin/stdout. Mirrors the `import.meta.url.endsWith(argv[1])`
// guard used by session-worker.ts.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  await createPresentBridgeServer().connect(new StdioServerTransport());
}
