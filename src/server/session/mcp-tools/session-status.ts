import type { ToolDescriptor } from "./types.js";
import { MAX_PAYLOAD_LEN, MAX_DESC_LEN, MAX_ID_LEN, MAX_LABEL_LEN } from "../../shared/propose-actions-validation.js";
import {
  MAX_NEEDS_YOU_LEN,
  MAX_STATUS_LEN,
  validateSessionStatus,
} from "../../shared/session-status-validation.js";

const TOOL_DESCRIPTION = [
  "Write the session status card the user reads just above the input field, and offer the",
  "follow-up actions they can approve with a click. Call it as the LAST act of every turn.",
  "It describes THE SESSION, not this turn: what the session is about, how far it got,",
  "whether it is done or ready to merge, and work you have identified but not started.",
  "Every field is a delta on the stored card — an omitted field is left unchanged, and a",
  "call with NO arguments is you confirming the card still holds, which is what you send",
  "when nothing moved. A turn that ends with a question needs no call. Offers persist",
  "across turns: `actions` adds to the list, `actions` with `replaceActions: true` makes",
  "the given list the whole list (empty + replaceActions clears it). Remove an offer once",
  "you have done it. `needsYou` is what only the USER can do by hand; an action is YOUR",
  "work they approve with a click. Reviewing and merging the PR is ShipIt's default",
  "workflow and is never an offered action — say \"ready to merge\" in the status instead.",
  "Do not offer routine commands (run the tests / lint), and a choice that needs real",
  "discussion is a question, not an offer.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    status: {
      type: "string",
      maxLength: MAX_STATUS_LEN,
      description:
        `What the session is about, how far it got, and whether it is done or ready to merge (≤${MAX_STATUS_LEN} chars). ` +
        "Omit it to leave the stored status unchanged; it is required on the session's first call.",
    },
    needsYou: {
      type: "string",
      maxLength: MAX_NEEDS_YOU_LEN,
      description:
        `The one decision or hand action only the user can take (≤${MAX_NEEDS_YOU_LEN} chars). ` +
        "Omit it to leave it unchanged; pass \"\" to clear it.",
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
            description: `Short checkbox text (≤${MAX_LABEL_LEN} chars).`,
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
              "The card outlives this turn, so it must stand alone without conversation context: name the files, docs and issues to read rather than pasting their contents.",
          },
        },
        required: ["id", "label", "payload"],
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

    try {
      const res = await fetch(`${workerUrl}/agent-ops/session-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
