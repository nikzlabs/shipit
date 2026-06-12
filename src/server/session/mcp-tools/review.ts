/**
 * review tool — `submit_review_comments` (docs/125). Pure transport: forwards the
 * structured findings to the worker's `/agent-ops/review/submit` broker, which
 * authorizes, re-anchors, persists with `source: "ai"`, and broadcasts
 * `review_updated`. The worker injects the trusted `SESSION_ID`. Extracted from
 * the former standalone `mcp-review-bridge.ts` for the consolidated bridge.
 */

import type { ToolDescriptor } from "./types.js";

const TOOL_DESCRIPTION = [
  "Submit the results of a code/document review as anchored comments. Call this",
  "exactly ONCE per review with the selected material findings as a single array",
  "— do not call it per comment. Submit only issues with concrete user impact",
  "and a specific fix; omit style opinions, speculative concerns, and nice-to-have",
  "improvements. If the file needs no comments, still call it with an empty array;",
  "that is the signal that the review ran. Each item MUST be an object with a `kind`",
  "field — \"selection\" for a verbatim quote anchor or \"line\" for a 1-based line",
  "anchor — and a `text` field. Line anchors are valid for code and markdown",
  "files; selection anchors are for markdown prose. Bare strings or string arrays are rejected. You",
  "do not pass a session id; review identity is set server-side. After this tool",
  "returns, the response text MUST be echoed verbatim as your final assistant",
  "message — the calling parent agent depends on it for the structured findings.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    file_path: {
      type: "string",
      description: "Path of the file being reviewed (relative to the repo root).",
    },
    comments: {
      type: "array",
      description: "All review comments. May be empty if the file needs no changes.",
      items: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { const: "selection" },
              quoted_text: {
                type: "string",
                description:
                  "The exact run of text from the document that the comment applies to. Copy it verbatim — whitespace and punctuation must match so the server can re-locate it.",
              },
              context_before: {
                type: "string",
                description:
                  "Up to ~50 characters of text immediately preceding `quoted_text` in the document. Used to disambiguate when the same `quoted_text` appears multiple times. Optional but recommended.",
              },
              context_after: {
                type: "string",
                description:
                  "Up to ~50 characters of text immediately following `quoted_text` in the document. Used to disambiguate when the same `quoted_text` appears multiple times. Optional but recommended.",
              },
              text: { type: "string", description: "The review comment." },
            },
            required: ["kind", "quoted_text", "text"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "line" },
              line: { type: "number", description: "1-based line number." },
              text: { type: "string", description: "The review comment." },
            },
            required: ["kind", "line", "text"],
          },
        ],
      },
    },
  },
  required: ["file_path", "comments"],
};

export const reviewTool: ToolDescriptor = {
  id: "review",
  name: "submit_review_comments",
  description: TOOL_DESCRIPTION,
  inputSchema,
  async call(args, { workerUrl }) {
    const a = args as { file_path?: string; comments?: unknown[] };
    try {
      const res = await fetch(`${workerUrl}/agent-ops/review/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: a.file_path, comments: a.comments }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        added?: number;
        rendered?: string;
      };
      if (!res.ok) {
        const reason = body.error || `review service returned HTTP ${res.status}`;
        return {
          content: [{ type: "text", text: `submit_review_comments failed: ${reason}` }],
          isError: true,
        };
      }
      // The orchestrator renders the structured findings into a text block
      // (docs/151); the subagent echoes this verbatim as its final message so
      // the parent receives it via the Task tool's return-the-final-message contract.
      const rendered =
        body.rendered ??
        `Recorded ${body.added ?? 0} review comment${body.added === 1 ? "" : "s"}.`;
      return { content: [{ type: "text", text: rendered }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `submit_review_comments could not reach the review service: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
};
