/**
 * mcp-bug-bridge — stdio MCP server that exposes the `report_shipit_bug` tool
 * to the agent CLI and forwards each call to the session worker (docs/164).
 *
 * Pure transport, exactly like `mcp-voice-bridge.ts` / `mcp-review-bridge.ts`:
 * no state, no business logic. The agent calls `report_shipit_bug` with a
 * `{ title, body }` draft; this bridge POSTs it to the worker's
 * `/agent-ops/bug/report` broker, which relays to the orchestrator's
 * session-scoped `/bug-report` route. There, the body is REDACTED server-side
 * and rendered as an inline consent card. The tool PROPOSES a report; it does
 * NOT create the GitHub issue — that only happens after the user confirms the
 * card. The agent never sees the user's GitHub token and never files directly.
 *
 * When the worker is down the fetch fails and the tool surfaces a clear error
 * rather than hanging.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAME = "report_shipit_bug";

const WORKER_URL = `http://127.0.0.1:${process.env.WORKER_PORT || "9100"}`;

const TOOL_DESCRIPTION = [
  "Propose a bug report about ShipIt ITSELF (the IDE/platform — e.g. the preview",
  "won't reload, ShipIt keeps killing the container, a button is broken), not about",
  "the user's own project. Call this when the user describes a problem with ShipIt",
  "and wants it reported. You author a concise `title` and a `body` (what happened +",
  "repro steps, in the user's words). ShipIt REDACTS the body server-side and shows",
  "the user an inline consent card with the exact redacted payload; NOTHING is filed",
  "until the user explicitly confirms. Do NOT include the user's email, their",
  "project's repo URL or name, secrets, tokens, or workspace file contents — only",
  "the redacted interaction with ShipIt matters, and the issue is PUBLIC and filed",
  "under the user's own GitHub identity. After this returns, tell the user a review",
  "card has been posted for them to confirm.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    title: {
      type: "string",
      description: "A short, specific issue title summarizing the ShipIt bug.",
    },
    body: {
      type: "string",
      description:
        "The report body: what happened and how to reproduce it, in the user's words. This is redacted server-side before the user reviews it.",
    },
  },
  required: ["title", "body"],
};

// Low-level Server (not McpServer) so we can pass a plain JSON Schema rather
// than a zod schema — keeps zod transitive. Mirrors mcp-voice-bridge.ts.
// eslint-disable-next-line @typescript-eslint/no-deprecated
const server = new Server(
  { name: "shipit-bug", version: "1.0.0" },
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

  const args = (req.params.arguments ?? {}) as { title?: string; body?: string };

  try {
    const res = await fetch(`${WORKER_URL}/agent-ops/bug/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: args.title, body: args.body }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      stage2Ran?: boolean;
    };
    if (!res.ok) {
      const reason = body.error || `bug-report service returned HTTP ${res.status}`;
      return {
        content: [{ type: "text" as const, text: `report_shipit_bug failed: ${reason}` }],
        isError: true,
      };
    }
    const message =
      body.message ??
      "A redacted bug-report card has been posted in the chat for the user to review and confirm. Nothing has been filed yet.";
    return { content: [{ type: "text" as const, text: message }] };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      content: [
        { type: "text" as const, text: `report_shipit_bug could not reach the worker: ${reason}` },
      ],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
