/**
 * permission tool — `permission_prompt` (SHI-112 / docs/193). Registered as the
 * Claude CLI's `--permission-prompt-tool`: instead of auto-denying a gated
 * (sensitive-file) edit in headless mode, the CLI calls this tool, which
 * forwards the request to the worker's `PermissionBroker` and BLOCKS until the
 * user answers the approve/deny card.
 *
 * Resilient long poll (Thread B / SHI-112): it does NOT hold one fetch open for
 * the whole wait (that trips undici's timeout when a user takes their time).
 * Instead it opens the request, then polls `/await` in short bounded holds.
 * Network blips are retried with exponential backoff; a real 4xx/5xx broker
 * rejection fails closed immediately. Extracted verbatim from the former
 * standalone `mcp-permission-bridge.ts` for the consolidated bridge.
 */

import type { ToolDescriptor } from "./types.js";

const TOOL_DESCRIPTION = [
  "Internal ShipIt permission-prompt tool. The Claude CLI invokes this",
  "automatically when an action needs user approval (e.g. editing a sensitive",
  "file); it is not meant to be called directly by the model.",
].join(" ");

// The CLI passes the gated call as { tool_name, input, tool_use_id }.
const inputSchema = {
  type: "object" as const,
  properties: {
    tool_name: { type: "string", description: "The tool awaiting permission." },
    input: { type: "object", description: "The proposed input for that tool." },
    tool_use_id: { type: "string", description: "The gated tool call's id." },
  },
  required: ["tool_name"],
};

/** Bounded hold per `await` poll — short enough that no client timeout fires. */
export const POLL_TIMEOUT_MS = 25_000;
/** Consecutive network failures tolerated (with backoff) before failing closed. */
export const MAX_CONSECUTIVE_FAILURES = 6;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const backoffDelay = (attempt: number) => Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);

/** The CLI rejects anything but a single text block whose text is JSON. */
function envelope(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}

interface PermissionReply {
  behavior?: "allow" | "deny";
  message?: string;
  error?: string;
  requestId?: string;
  pending?: boolean;
}

async function postJson(
  workerUrl: string,
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; body: PermissionReply }> {
  const res = await fetch(`${workerUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as PermissionReply;
  return { ok: res.ok, status: res.status, body: parsed };
}

export const permissionTool: ToolDescriptor = {
  id: "permission",
  name: "permission_prompt",
  description: TOOL_DESCRIPTION,
  inputSchema,
  async call(args, { workerUrl, sleep }) {
    const a = args as {
      tool_name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
    };
    const toolInput = a.input ?? {};

    // Retry a transient network failure with backoff (a brief worker blip), but
    // surface a real broker rejection (4xx/5xx) immediately, and give up after a
    // sustained streak. Returns the parsed reply or throws on exhausted retries.
    const postResilient = async (path: string, body: unknown): Promise<PermissionReply> => {
      let failures = 0;
      for (;;) {
        try {
          const r = await postJson(workerUrl, path, body);
          if (!r.ok) {
            const httpErr = new Error(r.body.error || `permission service returned HTTP ${r.status}`);
            (httpErr as { httpRejection?: boolean }).httpRejection = true;
            throw httpErr;
          }
          return r.body;
        } catch (err) {
          const isHttpRejection = !!(err as { httpRejection?: boolean })?.httpRejection;
          if (isHttpRejection || ++failures >= MAX_CONSECUTIVE_FAILURES) throw err;
          await sleep(backoffDelay(failures - 1));
        }
      }
    };

    try {
      const opened = await postResilient("/agent-ops/permission/request", {
        toolName: a.tool_name ?? "Tool",
        input: toolInput,
        toolUseId: a.tool_use_id,
      });

      // Pre-approved (handled interrupt tool / remembered path): answered inline.
      if (opened.behavior) {
        return opened.behavior === "allow"
          ? envelope({ behavior: "allow", updatedInput: toolInput })
          : envelope({ behavior: "deny", message: opened.message || "Permission denied." });
      }

      const requestId = opened.requestId;
      if (!requestId) {
        return envelope({ behavior: "deny", message: "Permission service returned no request id." });
      }

      // Poll until the user answers. `pending` just means "ask again" — a slow
      // user loops here indefinitely with no failure (no ShipIt-imposed deadline).
      for (;;) {
        const reply = await postResilient("/agent-ops/permission/await", {
          requestId,
          timeoutMs: POLL_TIMEOUT_MS,
        });
        if (reply.pending) continue;
        if (reply.behavior === "allow") {
          // `updatedInput` is mandatory on allow — echo the original input back.
          return envelope({ behavior: "allow", updatedInput: toolInput });
        }
        return envelope({ behavior: "deny", message: reply.message || "Permission denied." });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return envelope({ behavior: "deny", message: `Permission request could not reach the worker: ${message}` });
    }
  },
};
