/**
 * mcp-permission-bridge — stdio MCP server that ShipIt registers as the Claude
 * CLI's `--permission-prompt-tool` (SHI-112 / docs/193).
 *
 * The Claude CLI gates certain actions — most importantly edits to files it
 * classifies as sensitive (`.npmrc`, `.env`, …) — behind a permission prompt
 * that fires even when the tool itself is allowlisted. In ShipIt's headless
 * (`-p`) runs there is no interactive prompt, so the CLI auto-DENIES and the
 * edit becomes an unrecoverable dead-end. `--permission-prompt-tool` is the
 * documented headless escape hatch: instead of auto-denying an "ask"-tier call,
 * the CLI invokes the named MCP tool and uses its result to allow or deny.
 *
 * This bridge is that tool. It receives the gated tool call, forwards it to the
 * worker's `PermissionBroker` (`POST /agent-ops/permission/request`), and BLOCKS
 * until the user answers the resulting approve/deny card. The broker's reply is
 * mapped to the CLI's expected envelope — a single text block whose text is
 * JSON-stringified `{behavior:"allow",updatedInput}` or
 * `{behavior:"deny",message}`. (`updatedInput` is mandatory on allow; we echo
 * the original input back unchanged.)
 *
 * Unlike the ask bridge (which never returns — the orchestrator tears the turn
 * down and answers out of band), this bridge MUST return a value to the same
 * blocked CLI call, so it mirrors the voice/present bridges' request/response
 * shape: a real round-trip whose response the worker holds open until resolved.
 *
 * Pure transport: no state, no policy. The remember-set and event broadcasting
 * all live in the worker's broker.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAME = "permission_prompt";

const WORKER_URL = `http://127.0.0.1:${process.env.WORKER_PORT || "9100"}`;

const TOOL_DESCRIPTION = [
  "Internal ShipIt permission-prompt tool. The Claude CLI invokes this",
  "automatically when an action needs user approval (e.g. editing a sensitive",
  "file); it is not meant to be called directly by the model.",
].join(" ");

// The CLI passes the gated call as { tool_name, input, tool_use_id }.
const inputSchema = {
  type: "object" as const,
  properties: {
    tool_name: { type: "string", description: "The tool awaiting permission." },
    input: { type: "object", description: "The proposed input for that tool." },
    tool_use_id: { type: "string", description: "The gated tool call's id." },
  },
  required: ["tool_name"],
};

// Low-level Server (not McpServer) so we can pass a plain JSON Schema rather
// than a zod schema — mirrors mcp-voice-bridge.ts.
// eslint-disable-next-line @typescript-eslint/no-deprecated
const server = new Server(
  { name: "shipit-permission", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema }],
  }),
);

/** The CLI rejects anything but a single text block whose text is JSON. */
function envelope(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== TOOL_NAME) {
    // Deny an unexpected tool rather than allowing it — fail closed.
    return envelope({ behavior: "deny", message: `Unknown tool: ${req.params.name}` });
  }

  const args = (req.params.arguments ?? {}) as {
    tool_name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
  };
  const toolInput = args.input ?? {};

  try {
    const res = await fetch(`${WORKER_URL}/agent-ops/permission/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: args.tool_name ?? "Tool",
        input: toolInput,
        toolUseId: args.tool_use_id,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      behavior?: "allow" | "deny";
      message?: string;
      error?: string;
    };
    if (!res.ok) {
      // Fail closed: a broker error becomes a deny so the CLI doesn't proceed
      // on an unconfirmed action.
      const reason = body.error || `permission service returned HTTP ${res.status}`;
      return envelope({ behavior: "deny", message: reason });
    }
    if (body.behavior === "allow") {
      // `updatedInput` is mandatory on allow — echo the original input back.
      return envelope({ behavior: "allow", updatedInput: toolInput });
    }
    return envelope({ behavior: "deny", message: body.message || "Permission denied." });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return envelope({ behavior: "deny", message: `Permission request could not reach the worker: ${message}` });
  }
});

await server.connect(new StdioServerTransport());
