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
 * one Claude emits (`{ questions: [...] }`). When Codex calls it, the Codex
 * adapter observes the `item/started` notification and re-emits it as a
 * normalized `AskUserQuestion` tool_use — so the existing question card,
 * interrupt, answer, and `--resume`/`thread/resume` logic is reused unchanged.
 *
 * Blocking semantics: for a WELL-FORMED call the tool intentionally never
 * returns. The orchestrator interrupts the turn the moment it sees the
 * `AskUserQuestion` tool_use (killing the Codex process, and with it this
 * bridge subprocess), then resumes the thread with the user's answer as the
 * next turn. So this handler holds the call open until the process is torn
 * down — the answer arrives out of band, never as this tool's result. A
 * MALFORMED call (no usable `questions`) returns an error immediately, so the
 * model can self-correct within the same turn instead of hanging, mirroring how
 * Claude's CLI rejects a malformed `AskUserQuestion` with a validation error.
 *
 * Pure transport, like mcp-voice-bridge.ts / mcp-present-bridge.ts: no state,
 * no orchestrator round-trip. The question surfaces through the adapter's event
 * stream, not through this bridge.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAME = "AskUserQuestion";

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

  // Well-formed: hold the call open. The orchestrator has already (or is about
  // to) observe the AskUserQuestion tool_use via the Codex adapter's event
  // stream, interrupt the turn, and resume with the user's answer as a fresh
  // turn — so this result is never consumed. When the orchestrator interrupts,
  // the Codex process (this subprocess's parent) is killed, our stdin closes,
  // and this process exits. Awaiting a never-resolving promise keeps the tool
  // call pending until then without busy-waiting or holding the event loop open
  // on its own.
  await new Promise<never>(() => {
    /* held until the orchestrator tears the turn down */
  });
  // Unreachable — present only to satisfy the handler's return type.
  return { content: [{ type: "text" as const, text: "" }] };
});

await server.connect(new StdioServerTransport());
