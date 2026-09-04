/**
 * ask tool — a normalized `AskUserQuestion` for Codex (docs/147). Codex lacks a
 * Default-mode native question tool, so this exposes one shaped exactly like the
 * one Claude emits. On a well-formed call it POSTs the questions to the worker
 * (`/agent-ops/ask/submit`), which injects a normalized `AskUserQuestion`
 * tool_use into the event stream so the existing question/interrupt/resume flow
 * is reused — then the tool HOLDS OPEN until the orchestrator tears the turn
 * down (the answer arrives out of band as the next turn). A malformed call (or
 * an unreachable worker) returns an error immediately so the model self-corrects
 * rather than hanging until Codex's ~120s MCP timeout. Extracted from the former
 * standalone `mcp-ask-bridge.ts` for the consolidated bridge.
 */

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
            // `minItems` because `hasUsableQuestions` REJECTS an empty array —
            // the card cannot render without an option, so this is an enforced
            // bound, not advice. The 2–4 count in the text stays advice: nothing
            // enforces it, and the schema must not claim otherwise.
            type: "array",
            minItems: 1,
            description: "The available choices (2-4 recommended; at least one is required).",
            items: {
              type: "object",
              properties: {
                // `minLength` because an option whose label is blank is dropped
                // by `normalizeAskQuestions`, and a question left with no
                // options is rejected. Enforced, so it is declared.
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

/**
 * True when the payload survives the SAME normalization the worker route runs
 * (`/agent-ops/ask/submit` → `normalizeAskQuestions`), which is what decides
 * whether a card can render at all.
 *
 * It used to re-implement a weaker rule — "every question has a non-empty
 * `options` array" — and that gap is the exact defect this file's sibling
 * `propose_actions` was fixed for (docs/207): an option whose `label` is blank
 * or missing is DROPPED by the normalizer, so `options: [{ label: "" }]` passed
 * the pre-check, crossed into the worker, normalized to nothing, and came back
 * a 400. Deferring to the normalizer means the pre-check cannot be weaker than
 * the thing it is pre-checking.
 */
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

    // Malformed → fail fast so the model retries within the same turn.
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

    // Well-formed: push to the worker so it renders the card and the
    // orchestrator interrupts this turn. Surface a reach/reject failure rather
    // than blocking — otherwise the call hangs until Codex's MCP timeout.
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

    // Surfaced. Hold the call open: the orchestrator has observed the injected
    // AskUserQuestion tool_use and will interrupt the turn (killing the Codex
    // process, and with it this bridge), then resume with the user's answer as a
    // fresh turn — so this result is never consumed.
    await new Promise<never>(() => {
      /* held until the orchestrator tears the turn down */
    });
    // Unreachable — present only to satisfy the return type.
    return { content: [{ type: "text", text: "" }] };
  },
};
