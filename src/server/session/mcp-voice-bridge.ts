/**
 * mcp-voice-bridge — stdio MCP server that exposes the built-in `voice_note`
 * tool to the agent CLI and forwards each call to the session worker (docs/163).
 *
 * Pure transport, exactly like `mcp-present-bridge.ts` / `mcp-review-bridge.ts`:
 * no state, no business logic. The agent calls `voice_note` with an ear-shaped
 * `{ summary, needsAttention, context }` payload; this bridge POSTs it to the
 * worker's `/agent-ops/voice/note` broker, which relays to the orchestrator's
 * session-scoped `/voice-note` route. The orchestrator's router decides
 * delivery (native inline note + TTS, external webhook, or both) — the agent
 * never knows which. That is the whole point: delivery is the user's setting,
 * not the agent's decision.
 *
 * The agent calls this the same way regardless of how the user routes it, and
 * ShipIt is guaranteed to observe the call (it's a tool result, not a parse of
 * prose). When the worker is down the fetch fails and the tool surfaces a clear
 * error rather than hanging.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAME = "voice_note";

const WORKER_URL = `http://127.0.0.1:${process.env.WORKER_PORT || "9100"}`;

const TOOL_DESCRIPTION = [
  "Emit a short, ear-shaped spoken summary for the user. Call this at the END of",
  "a turn when you need the user's attention, and sparingly mid-task for an",
  "occasional heads-up. The `summary` is a one-or-two-sentence HEADLINE written",
  "for the ear (no markdown, no code, no file paths, no PR numbers) — it grabs",
  "attention and orients the user; it does NOT convey the body (the screen still",
  "holds the options, plan, or diff). Set `needsAttention: true` only when you",
  "genuinely need the user (a question, a decision, plan approval, blocking",
  "ambiguity, an error needing input, or a failed/abandoned turn) — these are",
  "spoken aloud. Set `needsAttention: false` for FYIs (work done, nothing to",
  "decide) — these render as a silent note with no audio. Before calling",
  "AskUserQuestion or ExitPlanMode, author the headline here FIRST in the same",
  "turn so the spoken note is a real script rather than a terse chip. Do not",
  "describe how the summary is delivered — that is the user's setting.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    summary: {
      type: "string",
      description:
        "A one-or-two-sentence spoken headline written for the ear. No markdown, code, file paths, commit hashes, or PR numbers.",
    },
    needsAttention: {
      type: "boolean",
      description:
        "true when you need the user (question, decision, plan approval, blocking ambiguity, error, failed turn) → spoken aloud. false for FYIs → silent note.",
    },
    context: {
      type: "object",
      description:
        "Optional display-only metadata. Include repo, prUrl, prTitle when known. prUrl is never spoken; prTitle becomes the link label on text channels.",
      properties: {
        repo: { type: "string" },
        prUrl: { type: "string" },
        prTitle: { type: "string" },
      },
    },
  },
  required: ["summary", "needsAttention"],
};

// Low-level Server (not McpServer) so we can pass a plain JSON Schema rather
// than a zod schema — keeps zod transitive. Mirrors mcp-present-bridge.ts.
// eslint-disable-next-line @typescript-eslint/no-deprecated
const server = new Server(
  { name: "shipit-voice", version: "1.0.0" },
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
    summary?: string;
    needsAttention?: boolean;
    context?: Record<string, unknown>;
  };

  try {
    const res = await fetch(`${WORKER_URL}/agent-ops/voice/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: args.summary,
        needsAttention: args.needsAttention,
        context: args.context,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      delivered?: boolean;
    };
    if (!res.ok) {
      const reason = body.error || `voice service returned HTTP ${res.status}`;
      return {
        content: [{ type: "text" as const, text: `voice_note failed: ${reason}` }],
        isError: true,
      };
    }
    // Report the orchestrator's real delivery outcome. The route always returns
    // an explicit `delivered` boolean on its 2xx path; treat a missing field as
    // NOT delivered rather than defaulting to true, so a genuine no-sink /
    // torn-down-runner case isn't masked as success (this masking made a native
    // render bug hard to diagnose — see docs/163).
    const delivered = body.delivered === true;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ status: delivered ? "delivered" : "not_delivered", delivered }),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        { type: "text" as const, text: `voice_note could not reach the worker: ${message}` },
      ],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
