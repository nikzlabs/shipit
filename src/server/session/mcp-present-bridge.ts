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
  "Display a single self-contained visual artifact (HTML, SVG, markdown, or image",
  "data URI) to the user in the dedicated Present tab WITHOUT writing it to the",
  "workspace. Use this for ephemeral artifacts you want the user to look at but not",
  "commit: charts, diagrams, mockups, rendered docs, quick HTML prototypes.",
  "For multi-file apps or files the user actually wants to keep, use Write instead",
  "— the workspace is for deliverables, the Present tab is for scratch visuals.",
  "Pass `replaceId` with a prior call's `presentId` to revise an existing",
  "presentation in-place (e.g. mockup v1 → v2); omit it for a brand-new entry.",
  "Returns `{ presentId }` so you can reference the presentation later.",
  "Content is capped at ~1 MB; larger artifacts will be rejected.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    content: {
      type: "string",
      description:
        "The artifact content. For HTML/SVG/markdown, pass the raw markup as a string. For images, pass a data URI like 'data:image/png;base64,...'.",
    },
    mimeType: {
      type: "string",
      description:
        "MIME type of the content: 'text/html', 'image/svg+xml', 'text/markdown', 'image/png', 'image/jpeg', 'image/gif'. Defaults to 'text/html'.",
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
  required: ["content"],
};

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
    { capabilities: { tools: {} } },
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
      content?: string;
      mimeType?: string;
      title?: string;
      replaceId?: string;
    };

    try {
      const res = await fetch(`${WORKER_URL}/agent-ops/present/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: args.content,
          mimeType: args.mimeType,
          title: args.title,
          replaceId: args.replaceId,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        presentId?: string;
        status?: string;
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
