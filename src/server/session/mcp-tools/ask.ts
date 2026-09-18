
import type { ToolDescriptor } from "./types.js";
import { normalizeAskQuestions } from "../ask-question.js";

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
      minItems: 1,
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
            minItems: 1,
            description: "The available choices (2-4 recommended; at least one is required).",
            items: {
              type: "object",
              properties: {
                label: { type: "string", minLength: 1, description: "The option's display text (must not be empty)." },
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

export function hasUsableQuestions(args: { questions?: unknown }): boolean {
  return normalizeAskQuestions(args.questions).length > 0;
}

export const askTool: ToolDescriptor = {
  id: "ask",
  name: "AskUserQuestion",
  description: TOOL_DESCRIPTION,
  inputSchema,
  async call(args, { workerUrl }) {
    const a = args as { questions?: unknown };

    if (!hasUsableQuestions(a)) {
      return {
        content: [
          {
            type: "text",
            text:
              "AskUserQuestion requires a non-empty `questions` array, and each question must have at least one option. " +
              "Provide questions shaped like { question, header, options: [{ label, description }], multiSelect? } and try again.",
          },
        ],
        isError: true,
      };
    }

    try {
      const res = await fetch(`${workerUrl}/agent-ops/ask/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questions: a.questions }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const reason = body.error || `ask service returned HTTP ${res.status}`;
        return {
          content: [{ type: "text", text: `AskUserQuestion failed to surface: ${reason}` }],
          isError: true,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: `AskUserQuestion could not reach the worker: ${message}` },
        ],
        isError: true,
      };
    }

    // Hold until the orchestrator stops this turn; the answer starts a new turn.
    await new Promise<never>(() => {
      // The orchestrator ends this process when the question appears.
    });
    return { content: [{ type: "text", text: "" }] };
  },
};
