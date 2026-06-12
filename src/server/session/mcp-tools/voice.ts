/**
 * voice tool — `voice_note` (docs/163). Pure transport: POSTs the ear-shaped
 * payload to the worker's `/agent-ops/voice/note` broker, which relays to the
 * orchestrator's voice router (native note, webhook, or both — the user's
 * setting). Reports the orchestrator's real `delivered` outcome rather than
 * defaulting to success. Extracted from the former standalone
 * `mcp-voice-bridge.ts` for the consolidated bridge.
 */

import type { ToolDescriptor } from "./types.js";

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

export const voiceTool: ToolDescriptor = {
  id: "voice",
  name: "voice_note",
  description: TOOL_DESCRIPTION,
  inputSchema,
  async call(args, { workerUrl }) {
    const a = args as {
      summary?: string;
      needsAttention?: boolean;
      context?: Record<string, unknown>;
    };
    try {
      const res = await fetch(`${workerUrl}/agent-ops/voice/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: a.summary,
          needsAttention: a.needsAttention,
          context: a.context,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        delivered?: boolean;
      };
      if (!res.ok) {
        const reason = body.error || `voice service returned HTTP ${res.status}`;
        return {
          content: [{ type: "text", text: `voice_note failed: ${reason}` }],
          isError: true,
        };
      }
      // Report the orchestrator's real delivery outcome. Treat a missing field
      // as NOT delivered rather than defaulting to true, so a genuine no-sink /
      // torn-down-runner case isn't masked as success (see docs/163).
      const delivered = body.delivered === true;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: delivered ? "delivered" : "not_delivered", delivered }),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: `voice_note could not reach the worker: ${message}` },
        ],
        isError: true,
      };
    }
  },
};
