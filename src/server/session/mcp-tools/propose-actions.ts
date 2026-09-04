/**
 * propose_actions tool — action checklist cards (docs/207 / planning#155).
 *
 * Pure transport: POSTs the proposed actions to the worker's
 * `/agent-ops/propose-actions` broker, which relays to the orchestrator. The
 * orchestrator validates the payload, stamps emit-time provenance, and renders a
 * reusable batch-resolve card in the transcript. The tool is NON-BLOCKING —
 * unlike `AskUserQuestion` it does not interrupt the turn: it posts the card and
 * returns, and the turn ends normally. The card is a message composer with no
 * connection to this turn; the user resolves it later (now, or a week from now)
 * with a single submit that arrives as a fresh user turn.
 *
 * A malformed call is rejected with a model-readable message (fail-fast
 * pre-check, plus the orchestrator's authoritative 400) so the model
 * self-corrects within the turn rather than emitting a broken card.
 */

import type { ToolDescriptor } from "./types.js";
import {
  validateProposeActions,
  MAX_ACTIONS,
  MAX_DESC_LEN,
  MAX_ID_LEN,
  MAX_LABEL_LEN,
  MAX_PAYLOAD_LEN,
  MAX_TITLE_LEN,
} from "../../shared/propose-actions-validation.js";

const TOOL_DESCRIPTION = [
  "Propose one or more INDEPENDENT optional follow-up actions as a card the user",
  "resolves with a single click, instead of asking in prose. One action renders",
  "as a button; two or more render as a checklist the user ticks and submits",
  "once. Use this for THIS-TURN-SPECIFIC follow-ups you just identified (e.g.",
  "'open a PR for this change', 'file an issue for the rate-limit edge case',",
  "'update the API docs for the new route') — the actions the user can take or",
  "skip. Each action needs a stable `id`, a short `label`, an optional one-line",
  "`description`, an optional `defaultChecked` recommendation, and a `payload`:",
  "the self-contained instruction you should act on if the user picks it (the",
  "card outlives this turn, so the payload can't rely on conversation context —",
  `but keep it under ${MAX_PAYLOAD_LEN} chars: name the files, docs or issue to`,
  "read instead of pasting their content, or the call is rejected).",
  "The card is non-blocking — it waits in the transcript; your turn",
  "ends normally. Call it LAST, after your closing text: the card is anchored",
  "where the tool fired, so proposing before you write your reply renders the",
  "card above the prose that explains it and the user has to scroll back for it.",
  "Do NOT use it for routine recurring commands (run the tests /",
  "lint / typecheck), do not emit one every turn, and do not also repeat the same",
  "suggestion in prose. Cap it at ~3–5 actions, at most one card per turn. When a",
  "choice needs real discussion or is mutually exclusive, ask a question instead.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    title: {
      type: "string",
      maxLength: MAX_TITLE_LEN,
      description: `Optional heading for the card, e.g. "Optional follow-ups" (≤${MAX_TITLE_LEN} chars).`,
    },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_ACTIONS,
      description: `1–${MAX_ACTIONS} independent optional actions. One → button card; 2+ → checklist card.`,
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            maxLength: MAX_ID_LEN,
            description: `Stable, unique id for this action within the card (≤${MAX_ID_LEN} chars).`,
          },
          label: {
            type: "string",
            maxLength: MAX_LABEL_LEN,
            description: `Short button / checkbox text (≤${MAX_LABEL_LEN} chars).`,
          },
          description: {
            type: "string",
            maxLength: MAX_DESC_LEN,
            description: `Optional one-line explanation shown under the label (≤${MAX_DESC_LEN} chars).`,
          },
          defaultChecked: {
            type: "boolean",
            description: "Your recommendation — pre-ticks the box. The user still decides.",
          },
          payload: {
            type: "string",
            maxLength: MAX_PAYLOAD_LEN,
            description:
              `The self-contained instruction you act on if this action is selected — at most ${MAX_PAYLOAD_LEN} characters, and a longer one is REJECTED. ` +
              "It must stand alone without conversation context (the card can be submitted long after this turn), so state the goal, the constraints, and " +
              "WHERE to read the rest: name files, docs and issues rather than pasting their contents. A few sentences is normal; an essay means context that belongs in the repo.",
          },
        },
        required: ["id", "label", "payload"],
      },
    },
  },
  required: ["actions"],
};

// Server-level guidance — surfaced to either agent's tool index so it reaches for
// `propose_actions` when it would otherwise suggest follow-ups in prose. This
// governs FORM only (button/checklist vs typing the answer); the bar for
// *whether* to suggest is unchanged and lives in the existing prompts. Kept
// concise (Claude truncates instructions at ~2 KB).
const INSTRUCTIONS = [
  "When you would suggest one or more concrete, optional follow-up actions the",
  "user can accept or decline, render them with `propose_actions` instead of",
  "asking in prose — the user ticks and clicks rather than typing the answer.",
  "Good actions are this-moment-specific (open a PR, file a follow-up issue,",
  "update the docs for the route you just added), not routine recurring commands",
  "(run the tests / lint). Don't emit a card every turn, don't pair a card with",
  "the same suggestion in prose, and prefer plain text when an action is vague or",
  "needs discussion. Cap at ~3–5 actions, at most one card per turn.",
].join(" ");

export const proposeActionsTool: ToolDescriptor = {
  id: "propose_actions",
  name: "propose_actions",
  description: TOOL_DESCRIPTION,
  inputSchema,
  instructions: INSTRUCTIONS,
  async call(args, { workerUrl }) {
    const a = args as { title?: unknown; actions?: unknown };

    // Fail-fast pre-check with the SAME validator the orchestrator runs, so a
    // rejection costs no round trip and the model can repair the call inside the
    // turn that authored it. (It used to check only "is `actions` non-empty",
    // which let every length violation travel to the orchestrator and back.)
    const pre = validateProposeActions(a);
    if ("error" in pre) {
      return {
        content: [{ type: "text", text: `propose_actions failed: ${pre.error}` }],
        isError: true,
      };
    }

    try {
      const res = await fetch(`${workerUrl}/agent-ops/propose-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: a.title, actions: a.actions }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        count?: number;
      };
      if (!res.ok) {
        const reason = body.error || `propose_actions service returned HTTP ${res.status}`;
        return {
          content: [{ type: "text", text: `propose_actions failed: ${reason}` }],
          isError: true,
        };
      }
      const n = body.count ?? (a.actions as unknown[]).length;
      return {
        content: [
          {
            type: "text",
            text:
              `Posted an action card with ${n} action${n === 1 ? "" : "s"} in the chat. ` +
              "The user can tick a subset and submit when they're ready — it arrives as a new message. " +
              "Do not repeat these suggestions in prose; end your turn.",
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: `propose_actions could not reach the worker: ${message}` },
        ],
        isError: true,
      };
    }
  },
};
