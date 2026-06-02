/**
 * mcp-ask-bridge — stdio MCP server that exposes a normalized `AskUserQuestion`
 * tool to the Codex CLI (docs/147).
 *
 * Why this exists: Claude Code ships `AskUserQuestion` natively, so the
 * orchestrator's interrupt/answer/resume machinery (agent-listeners.ts keys on
 * the tool name `AskUserQuestion`) just works for Claude. Codex has no
 * equivalent available in Default mode — its native `request_user_input` is
 * gated behind a Plan-mode-only experimental feature, so the model falls back
 * to a plain-text "the question tool is only available in Plan mode" message.
 *
 * Rather than enable that experimental native tool (which would require a
 * blocking JSON-RPC answer channel and a brand-new answer method), we register
 * an `AskUserQuestion` MCP tool whose input is already shaped exactly like the
 * one Claude emits (`{ questions: [...] }`). When Codex calls it, this bridge
 * POSTs the questions to the worker (`POST /agent-ops/ask/submit`), which
 * injects a normalized `AskUserQuestion` tool_use into the agent event stream —
 * so the existing question card, interrupt, answer, and `thread/resume` logic
 * is reused unchanged.
 *
 * Why the worker round-trip instead of the adapter's event stream? The original
 * design (docs/147) assumed the Codex app-server emits an `item/started`
 * notification the moment this MCP tool is called, which the adapter could
 * re-emit. It does NOT: Codex surfaces an `mcpToolCall` item only on
 * `item/completed`, after the tool returns — and a well-formed question never
 * returns. So nothing ever reached the UI and the call sat until Codex's own
 * MCP tool-call timeout (~120s) fired. Pushing the question over HTTP (the same
 * bridge→worker→orchestrator path voice/present/review use) guarantees the card
 * renders and the orchestrator interrupts immediately, regardless of what Codex
 * emits on its event stream.
 *
 * Blocking semantics: for a WELL-FORMED call, once the worker has accepted the
 * question the tool intentionally never returns. The orchestrator interrupts
 * the turn the moment it sees the injected `AskUserQuestion` tool_use (killing
 * the Codex process, and with it this bridge subprocess), then resumes the
 * thread with the user's answer as the next turn. So this handler holds the
 * call open until the process is torn down — the answer arrives out of band,
 * never as this tool's result. A MALFORMED call (no usable `questions`) — or a
 * worker that can't be reached — returns an error immediately, so the model can
 * self-correct or retry within the same turn instead of hanging.
 *
 * Pure transport, like mcp-voice-bridge.ts / mcp-present-bridge.ts: no state,
 * no business logic.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAME = "AskUserQuestion";

const WORKER_URL = `http://127.0.0.1:${process.env.WORKER_PORT || "9100"}`;

const TOOL_DESCRIPTION = [
  "Ask the user one or more multiple-choice questions and pause until they",
  "answer. Use this when you need a decision you can't safely make yourself —",
  "picking between approaches, confirming a destructive action, resolving an",
  "ambiguous requirement. Each question renders as a card with selectable",
  "options (plus a free-text 'Other'); the user's selection comes back as your",
  "next message. Prefer this over asking in prose: the structured card is",
  "clearer and the answer is delivered reliably. Provide 2-4 concrete options",
  "per question with short descriptions. This works in any mode.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    questions: {
      type: "array",
      description: "One or more questions to ask the user.",
      items: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The full question text shown to the user.",
          },
          header: {
            type: "string",
            description: "A very short label/category for the question (max ~12 chars).",
          },
          multiSelect: {
            type: "boolean",
            description: "Allow selecting multiple options instead of just one. Defaults to false.",
          },
          options: {
            type: "array",
            description: "The available choices (2-4 recommended).",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "The option's display text." },
                description: {
                  type: "string",
                  description: "A short explanation of what the option means.",
                },
              },
              required: ["label"],
            },
          },
        },
        required: ["question", "header", "options"],
      },
    },
  },
  required: ["questions"],
};

/**
 * True when the payload carries at least one question with a non-empty
 * `options` array. Matches the orchestrator's `isWellFormedAskUserQuestion`
 * gate: a call that doesn't satisfy this is rejected (the question card can't
 * render and the orchestrator won't interrupt), so we surface the error to the
 * model rather than blocking forever.
 */
function hasUsableQuestions(args: { questions?: unknown }): boolean {
  const questions = args.questions;
  if (!Array.isArray(questions) || questions.length === 0) return false;
  return questions.every((q) => {
    if (typeof q !== "object" || q === null) return false;
    const opts = (q as { options?: unknown }).options;
    return Array.isArray(opts) && opts.length > 0;
  });
}

// Low-level Server (not McpServer) so we can pass a plain JSON Schema rather
// than a zod schema — keeps zod transitive. Mirrors mcp-voice-bridge.ts.
// eslint-disable-next-line @typescript-eslint/no-deprecated
const server = new Server(
  { name: "shipit-ask", version: "1.0.0" },
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

  const args = (req.params.arguments ?? {}) as { questions?: unknown };

  // Malformed → fail fast so the model retries within the same turn (the card
  // can't render and the orchestrator won't interrupt on an empty `questions`).
  if (!hasUsableQuestions(args)) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "AskUserQuestion requires a non-empty `questions` array, and each question must have at least one option. " +
            "Provide questions shaped like { question, header, options: [{ label, description }], multiSelect? } and try again.",
        },
      ],
      isError: true,
    };
  }

  // Well-formed: push the question to the worker so it renders the card and the
  // orchestrator interrupts this turn. If the worker can't be reached or rejects
  // the payload, surface that to the model rather than blocking — otherwise the
  // call would hang until Codex's MCP timeout, the exact bug this path fixes.
  try {
    const res = await fetch(`${WORKER_URL}/agent-ops/ask/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions: args.questions }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const reason = body.error || `ask service returned HTTP ${res.status}`;
      return {
        content: [{ type: "text" as const, text: `AskUserQuestion failed to surface: ${reason}` }],
        isError: true,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        { type: "text" as const, text: `AskUserQuestion could not reach the worker: ${message}` },
      ],
      isError: true,
    };
  }

  // Surfaced. Hold the call open: the orchestrator has observed the injected
  // AskUserQuestion tool_use and will interrupt the turn (killing the Codex
  // process, and with it this subprocess), then resume with the user's answer
  // as a fresh turn — so this result is never consumed. Awaiting a
  // never-resolving promise keeps the tool call pending until then without
  // busy-waiting or holding the event loop open on its own.
  await new Promise<never>(() => {
    /* held until the orchestrator tears the turn down */
  });
  // Unreachable — present only to satisfy the handler's return type.
  return { content: [{ type: "text" as const, text: "" }] };
});

await server.connect(new StdioServerTransport());
