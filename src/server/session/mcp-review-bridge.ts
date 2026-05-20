/**
 * mcp-review-bridge — stdio MCP server that exposes the `submit_review_comments`
 * tool to Claude Code and forwards each call to the session worker (docs/125).
 *
 * This process is PURE TRANSPORT. It owns no state, no validation, and no
 * business logic. Claude Code spawns it as a subprocess (declared in the
 * `mcp.json` the worker generates), talks MCP over stdio, and this bridge
 * relays each tool call to the worker's `/agent-ops/review/submit` broker on
 * localhost — the same broker the `gh` / `shipit` shims use. The worker injects
 * the trusted `SESSION_ID` and relays to the orchestrator, where the real
 * handler lives: allow-list authorization (`runner.activeReviewFilePath`),
 * draft resolution, re-anchoring, persistence with `source: "ai"`, and the
 * `review_updated` broadcast.
 *
 * The bridge exists only because Claude Code's MCP transport is
 * stdio-over-subprocess; it cannot connect to an in-process handler. When the
 * worker is down, the fetch fails and the tool surfaces a clear error rather
 * than hanging.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAME = "submit_review_comments";

// Same localhost broker the agent shims reach (see agent-shim/gh.ts).
const WORKER_URL = `http://127.0.0.1:${process.env.WORKER_PORT || "9100"}`;

const TOOL_DESCRIPTION = [
  "Submit the results of a code/document review as anchored comments. Call this",
  "exactly ONCE per review with ALL findings as a single array — do not call it",
  "per comment. If the file needs no comments, still call it with an empty array;",
  "that is the signal that the review ran. Section comments anchor to a markdown",
  "`## heading`; line comments anchor to a 1-based line number in a code file.",
  "You do not pass a session id or a comment source — those are set server-side.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    file_path: {
      type: "string",
      description: "Path of the file being reviewed (relative to the repo root).",
    },
    comments: {
      type: "array",
      description: "All review comments. May be empty if the file needs no changes.",
      items: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { const: "section" },
              section_heading: {
                type: "string",
                description: 'The markdown heading line, e.g. "## Architecture".',
              },
              section_index: {
                type: "number",
                description: "0-based index of the section in the document.",
              },
              text: { type: "string", description: "The review comment." },
            },
            required: ["kind", "section_heading", "text"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "line" },
              line: { type: "number", description: "1-based line number." },
              text: { type: "string", description: "The review comment." },
            },
            required: ["kind", "line", "text"],
          },
        ],
      },
    },
  },
  required: ["file_path", "comments"],
};

// Use the low-level Server (not the high-level McpServer): McpServer's tool
// registration takes zod schemas, which would make zod a direct dependency of
// both runtimes. The low-level API accepts plain JSON Schema, keeping zod
// transitive. This is exactly the "advanced use case" the deprecation note
// carves out.
// eslint-disable-next-line @typescript-eslint/no-deprecated
const server = new Server(
  { name: "shipit-review", version: "1.0.0" },
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
    file_path?: string;
    comments?: unknown[];
  };

  try {
    const res = await fetch(`${WORKER_URL}/agent-ops/review/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: args.file_path, comments: args.comments }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      added?: number;
      outdated?: number;
    };
    if (!res.ok) {
      const reason = body.error || `review service returned HTTP ${res.status}`;
      return {
        content: [{ type: "text" as const, text: `submit_review_comments failed: ${reason}` }],
        isError: true,
      };
    }
    const added = body.added ?? 0;
    const outdated = body.outdated ?? 0;
    const outdatedNote =
      outdated > 0
        ? ` ${outdated} referenced a section that no longer exists and was marked outdated.`
        : "";
    const summary = `Recorded ${added} review comment${added === 1 ? "" : "s"}.${outdatedNote}`;
    return { content: [{ type: "text" as const, text: summary }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text" as const,
          text: `submit_review_comments could not reach the review service: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
