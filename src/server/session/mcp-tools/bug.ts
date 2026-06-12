/**
 * bug tool — `report_shipit_bug` (docs/164). Pure transport: POSTs the draft to
 * the worker's `/agent-ops/bug/report` broker, which redacts it server-side and
 * renders an inline consent card. The tool PROPOSES a report; nothing is filed
 * until the user confirms. Extracted from the former standalone
 * `mcp-bug-bridge.ts` for the consolidated bridge.
 */

import type { ToolDescriptor } from "./types.js";

const TOOL_DESCRIPTION = [
  "Propose a bug report about ShipIt ITSELF (the IDE/platform — e.g. the preview",
  "won't reload, ShipIt keeps killing the container, a button is broken), not about",
  "the user's own project. Call this when the user describes a problem with ShipIt",
  "and wants it reported. You author a concise `title` and a `body` (what happened +",
  "repro steps, in the user's words). ShipIt REDACTS the body server-side and shows",
  "the user an inline consent card with the exact redacted payload; NOTHING is filed",
  "until the user explicitly confirms. Do NOT include the user's email, their",
  "project's repo URL or name, secrets, tokens, or workspace file contents — only",
  "the redacted interaction with ShipIt matters, and the issue is PUBLIC and filed",
  "under the user's own GitHub identity. After this returns, tell the user a review",
  "card has been posted for them to confirm.",
].join(" ");

const inputSchema = {
  type: "object" as const,
  properties: {
    title: {
      type: "string",
      description: "A short, specific issue title summarizing the ShipIt bug.",
    },
    body: {
      type: "string",
      description:
        "The report body: what happened and how to reproduce it, in the user's words. This is redacted server-side before the user reviews it.",
    },
  },
  required: ["title", "body"],
};

export const bugTool: ToolDescriptor = {
  id: "bug",
  name: "report_shipit_bug",
  description: TOOL_DESCRIPTION,
  inputSchema,
  async call(args, { workerUrl }) {
    const a = args as { title?: string; body?: string };
    try {
      const res = await fetch(`${workerUrl}/agent-ops/bug/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: a.title, body: a.body }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        stage2Ran?: boolean;
      };
      if (!res.ok) {
        const reason = body.error || `bug-report service returned HTTP ${res.status}`;
        return {
          content: [{ type: "text", text: `report_shipit_bug failed: ${reason}` }],
          isError: true,
        };
      }
      const message =
        body.message ??
        "A redacted bug-report card has been posted in the chat for the user to review and confirm. Nothing has been filed yet.";
      return { content: [{ type: "text", text: message }] };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: `report_shipit_bug could not reach the worker: ${reason}` },
        ],
        isError: true,
      };
    }
  },
};
