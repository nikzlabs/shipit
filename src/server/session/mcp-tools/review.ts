/**
 * review tool — `submit_review` (docs/203). Pure transport: forwards a
 * plain-text markdown review to the worker's `/agent-ops/review/submit` broker,
 * which authorizes it against the active review turn's file allow-list,
 * persists a single review card, and broadcasts `ai_review_added`. The worker
 * injects the trusted `SESSION_ID`.
 *
 * This replaces the former structured `submit_review_comments` tool: the payload
 * is now ONE freeform markdown string, not a line/selection-anchored comment
 * array. The parent agent (which always has the ShipIt MCP server) calls this
 * after obtaining the reviewer's markdown — from a `Task` subagent or a
 * cross-agent `shipit agent run` — so the card path is identical in both modes.
 */

import type { ToolDescriptor } from "./types.js";

const TOOL_DESCRIPTION = [
  "Record a code/document review as a single plain-text markdown finding list.",
  "Call this ONCE with the reviewer's full markdown after you have obtained it",
  "(from a Task subagent or `shipit agent run`). The `markdown` is rendered",
  "verbatim as a collapsible review card in chat — pass the reviewer's output as",
  "received; do not re-summarize or strip it. Use \"No material issues found.\"",
  "when the review is clean. `reviewer_label` is the short attribution shown on",
  "the card (e.g. \"Reviewed by Codex\", \"Reviewed by Claude\"). You do not pass a",
  "session id; review identity is set server-side. This tool is only callable",
  "inside a review turn, for the single file under review. If you are re-reviewing",
  "after applying fixes, call it again with the updated markdown — it patches the",
  "same card in place rather than stacking a second one.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    file_path: {
      type: "string",
      description: "Path of the file being reviewed (relative to the repo root).",
    },
    markdown: {
      type: "string",
      description:
        "The reviewer's full review as markdown. Severity-ordered findings, each as `path:line — issue` with a specific fix, or \"No material issues found.\" when clean.",
    },
    reviewer_label: {
      type: "string",
      description:
        "Short attribution for the card, e.g. \"Reviewed by Codex\" or \"Reviewed by Claude (Codex unavailable)\". Optional; defaults to a generic label.",
    },
  },
  required: ["file_path", "markdown"],
};

export const reviewTool: ToolDescriptor = {
  id: "review",
  name: "submit_review",
  description: TOOL_DESCRIPTION,
  inputSchema,
  async call(args, { workerUrl }) {
    const a = args as { file_path?: string; markdown?: string; reviewer_label?: string };
    try {
      const res = await fetch(`${workerUrl}/agent-ops/review/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: a.file_path,
          markdown: a.markdown,
          reviewerLabel: a.reviewer_label,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        reReviewed?: boolean;
      };
      if (!res.ok) {
        const reason = body.error || `review service returned HTTP ${res.status}`;
        return {
          content: [{ type: "text", text: `submit_review failed: ${reason}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: body.reReviewed
              ? "Review card updated with the re-review."
              : "Review card recorded.",
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `submit_review could not reach the review service: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
};
