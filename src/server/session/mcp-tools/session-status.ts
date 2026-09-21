import type { ToolDescriptor } from "./types.js";
import { MAX_PAYLOAD_LEN, MAX_DESC_LEN, MAX_ID_LEN, MAX_LABEL_LEN } from "../../shared/propose-actions-validation.js";
import {
  MAX_LAST_TURN_LEN,
  MAX_NEEDS_YOU_ITEMS,
  MAX_NEEDS_YOU_LEN,
  MAX_STATUS_LEN,
  validateSessionStatus,
} from "../../shared/session-status-validation.js";
import { requireOfferDescriptions } from "../../shared/session-status-offers.js";

const TOOL_DESCRIPTION = [
  "Write the session status card the user reads just above the input field, and offer the",
  "follow-up actions they can approve with a click. Call it as the LAST act of every turn.",
  "`status` describes THE SESSION, not this turn: what the session is about, how far it got,",
  "whether it is done or ready to merge, and work you have identified but not started.",
  "`lastTurn` is the one line that IS about this turn — one or two sentences on what you did,",
  "or the direct answer when the user asked something. It is the ONLY field that is not a",
  "delta: every call rewrites it, and a call that omits it clears the line, so pass it again",
  "whenever the turn did something worth saying and leave it out when it did not.",
  `\`status\` is markdown and may carry a short list (up to ${MAX_STATUS_LEN} chars).`,
  "EVERY field is markdown, not only `status`: a step, a label and a description all render it,",
  "so a link into a file, an issue or the running app is a working link. Keep those to one",
  "short line — a heading or a list does not belong in a checkbox row.",
  "`needsYou` is a LIST, one entry per thing only the USER can do by hand, shown on the card",
  "under \"Manual steps\" with a toggle each; send [] to clear it. An action is YOUR work,",
  "shown under \"Follow-ups\", and every action needs a `description` as well as a `label`.",
  "Every OTHER field is a delta on the stored card — an omitted field is left unchanged, and a",
  "call with NO arguments is you confirming the card still holds, which is what you send",
  "when nothing moved. A turn that ends with a question needs no call. Offers persist",
  "across turns: `actions` adds to the list, `actions` with `replaceActions: true` makes",
  "the given list the whole list (empty + replaceActions clears it). Drop an offer once its",
  "work is done. Reviewing and merging the PR is ShipIt's default workflow and is never an",
  "offered action — say \"ready to merge\" in the status instead. Do not offer routine",
  "commands (run the tests / lint), and a choice that needs real discussion is a question,",
  "not an offer.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    lastTurn: {
      type: "string",
      maxLength: MAX_LAST_TURN_LEN,
      description:
        "One or two sentences on what you did in THIS turn, or the direct answer when the user "
        + `asked something (≤${MAX_LAST_TURN_LEN} chars). Not a delta: omit it and the line is `
        + "cleared, which is what you want when the turn produced nothing worth saying.",
    },
    status: {
      type: "string",
      maxLength: MAX_STATUS_LEN,
      description:
        "Markdown, and it may carry a short list: what the session is about, how far it got, "
        + `what is done and what is not started yet (≤${MAX_STATUS_LEN} chars). `
        + "Omit it to leave the stored status unchanged; it is required on the session's first call.",
    },
    needsYou: {
      type: "array",
      maxItems: MAX_NEEDS_YOU_ITEMS,
      description:
        "The things only the user can do by hand, one self-contained step per entry — the card "
        + "shows each with its own \"I've done this\" toggle and a note field. A step can come "
        + "back with a `Note:` line under it, or answered rather than done — a refusal or a "
        + "blocker — so read what comes back per step. Omit it to leave the list unchanged; "
        + "pass [] to clear it.",
      items: {
        type: "string",
        maxLength: MAX_NEEDS_YOU_LEN,
        description: `One step the user has to do by hand, as one short line of markdown (≤${MAX_NEEDS_YOU_LEN} chars).`,
      },
    },
    replaceActions: {
      type: "boolean",
      description:
        "false (default): add the given actions to the offered list. true: the given list becomes the whole list, and an empty list clears it.",
    },
    actions: {
      type: "array",
      description: "The follow-up actions you offer. Omit to leave the offered list unchanged.",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            maxLength: MAX_ID_LEN,
            description: `Stable name for this action, unique within the call (≤${MAX_ID_LEN} chars). Repeat it unchanged to keep the existing offer.`,
          },
          label: {
            type: "string",
            maxLength: MAX_LABEL_LEN,
            description: `Short checkbox text, markdown (≤${MAX_LABEL_LEN} chars).`,
          },
          description: {
            type: "string",
            maxLength: MAX_DESC_LEN,
            description:
              "Required: the one-line explanation in markdown shown under the label, which is what the user "
              + `reads to know what the action does before ticking it (≤${MAX_DESC_LEN} chars).`,
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
              "The card outlives this turn, so it must stand alone without conversation context: name the files, docs and issues to read rather than pasting their contents.",
          },
        },
        required: ["id", "label", "description", "payload"],
      },
    },
  },
};

interface OfferReply {
  offerId: string;
  id: string;
  label: string;
  taken: boolean;
}

function isOffer(value: unknown): value is OfferReply {
  const offer = value as OfferReply | null;
  return (
    typeof offer === "object" && offer !== null
    && typeof offer.id === "string" && typeof offer.label === "string"
  );
}

/**
 * The id is what a replacement has to repeat to keep an offer's identity, so the
 * reply names it. Labels and payloads are not echoed: an offer the agent wants
 * to keep is one it already wrote, and echoing every payload would put the whole
 * offered list into the reply of every call.
 */
function describeOffers(actions: OfferReply[]): string {
  if (actions.length === 0) return " No actions are offered.";
  const lines = actions.map(
    (a) => `- ${a.id}: ${a.label}${a.taken ? " (taken — drop it once you have done it)" : ""}`,
  );
  return ` Offered now, by id:\n${lines.join("\n")}`;
}

export const sessionStatusTool: ToolDescriptor = {
  id: "session_status",
  name: "session_status",
  description: TOOL_DESCRIPTION,
  inputSchema,
  async call(args, { workerUrl }) {
    const a = args as {
      lastTurn?: unknown;
      status?: unknown;
      needsYou?: unknown;
      actions?: unknown;
      replaceActions?: unknown;
    };

    // Whether a card is stored is the orchestrator's knowledge, so the local
    // pre-check assumes one and the route owns that refusal.
    const pre = validateSessionStatus(a, { hasStoredCard: true });
    if ("error" in pre) {
      return {
        content: [{ type: "text", text: `session_status failed: ${pre.error}` }],
        isError: true,
      };
    }
    // req 26 — the status card's own rule, so it is not in the shared item validator.
    const missingDescription = pre.actions ? requireOfferDescriptions(pre.actions) : null;
    if (missingDescription) {
      return {
        content: [{ type: "text", text: `session_status failed: ${missingDescription}` }],
        isError: true,
      };
    }

    try {
      const res = await fetch(`${workerUrl}/agent-ops/session-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lastTurn: a.lastTurn,
          status: a.status,
          needsYou: a.needsYou,
          actions: a.actions,
          replaceActions: a.replaceActions,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: unknown;
        error?: string;
        actions?: OfferReply[];
      } | null;
      if (!res.ok) {
        const reason = body?.error || `session_status service returned HTTP ${res.status}`;
        return {
          content: [{ type: "text", text: `session_status failed: ${reason}` }],
          isError: true,
        };
      }
      // A reply that cannot be read is not evidence the card was written, and
      // saying it was would cost the turn its only chance to write one.
      if (body?.ok !== true || !Array.isArray(body.actions) || !body.actions.every(isOffer)) {
        return {
          content: [{
            type: "text",
            text: "session_status failed: the service answered HTTP "
              + `${res.status} with a reply this tool could not read, so the card may not have been written. Call it again.`,
          }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `The status card above the input field is up to date.${describeOffers(body.actions)}`,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: `session_status could not reach the worker: ${message}` },
        ],
        isError: true,
      };
    }
  },
};
