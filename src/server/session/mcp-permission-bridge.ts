/**
 * mcp-permission-bridge — stdio MCP server that ShipIt registers as the Claude
 * CLI's `--permission-prompt-tool` (SHI-112 / docs/193).
 *
 * The Claude CLI gates certain actions — most importantly edits to files it
 * classifies as sensitive (`.npmrc`, `.env`, …) — behind a permission prompt
 * that fires even when the tool itself is allowlisted. In ShipIt's headless
 * (`-p`) runs there is no interactive prompt, so the CLI auto-DENIES and the
 * edit becomes an unrecoverable dead-end. `--permission-prompt-tool` is the
 * documented headless escape hatch: instead of auto-denying an "ask"-tier call,
 * the CLI invokes the named MCP tool and uses its result to allow or deny.
 *
 * This bridge is that tool. It receives the gated tool call and forwards it to
 * the worker's `PermissionBroker`, then BLOCKS until the user answers the
 * resulting approve/deny card. The broker's reply is mapped to the CLI's
 * expected envelope — a single text block whose text is JSON-stringified
 * `{behavior:"allow",updatedInput}` or `{behavior:"deny",message}`.
 * (`updatedInput` is mandatory on allow; we echo the original input back
 * unchanged.)
 *
 * Resilient long poll (Thread B / SHI-112). It does NOT hold one HTTP fetch open
 * for the whole wait: that fetch trips undici's headers/body timeout when a user
 * takes their time (or steps away to another session entirely), surfacing as
 * "fetch failed". The bridge then fails closed, the CLI denies the edit, and the
 * model retries — STACKING a fresh permission card each loop. Instead:
 *
 *   1. `POST /agent-ops/permission/request` opens the request and returns
 *      immediately — `{ behavior }` for a pre-approved action, else `{ requestId }`.
 *   2. `POST /agent-ops/permission/await` is polled in a loop, each poll a
 *      BOUNDED hold that returns `{ behavior }` once answered or `{ pending: true }`
 *      to poll again.
 *
 * Each poll is short, so a slow user never trips a client timeout, and a brief
 * worker unreachability is retried with exponential backoff (mirroring the SSE
 * reconnection layer) rather than hard-failing the tool call. We only fail
 * closed on a real broker rejection (4xx/5xx) or sustained unreachability. The
 * `request` open is idempotent on `tool_use_id` worker-side, so a retried open
 * re-attaches to the one card instead of stacking another.
 *
 * Pure transport: no state, no policy. The remember-set and event broadcasting
 * all live in the worker's broker.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAME = "permission_prompt";

const WORKER_URL = `http://127.0.0.1:${process.env.WORKER_PORT || "9100"}`;

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

/** The CLI rejects anything but a single text block whose text is JSON. */
function envelope(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}

/** Bounded hold per `await` poll — short enough that no client timeout fires. */
export const POLL_TIMEOUT_MS = 25_000;
/** Consecutive network failures tolerated (with backoff) before failing closed. */
export const MAX_CONSECUTIVE_FAILURES = 6;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const backoffDelay = (attempt: number) => Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);

interface PermissionReply {
  behavior?: "allow" | "deny";
  message?: string;
  error?: string;
  requestId?: string;
  pending?: boolean;
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; body: PermissionReply }> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as PermissionReply;
  return { ok: res.ok, status: res.status, body: parsed };
}

/**
 * Build the MCP `Server` with the `permission_prompt` tool wired. Factored out
 * of the module top-level (mirrors mcp-present-bridge.ts) so tests can drive it
 * over an in-process transport pair without spawning stdio. `sleep` is injected
 * so the retry backoff can be made instant in tests. Pure construction — no I/O
 * until the returned server is connected to a transport.
 */
export function createPermissionBridgeServer(opts?: { sleep?: (ms: number) => Promise<void> }) {
  const sleep = opts?.sleep ?? realSleep;

  // Low-level Server (not McpServer) so we can pass a plain JSON Schema rather
  // than a zod schema — mirrors mcp-voice-bridge.ts.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: "shipit-permission", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema }],
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== TOOL_NAME) {
      // Deny an unexpected tool rather than allowing it — fail closed.
      return envelope({ behavior: "deny", message: `Unknown tool: ${req.params.name}` });
    }

    const args = (req.params.arguments ?? {}) as {
      tool_name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
    };
    const toolInput = args.input ?? {};

    // Retry a transient network failure with backoff (a brief worker blip), but
    // surface a real broker rejection (4xx/5xx) immediately, and give up after a
    // sustained streak. Returns the parsed reply or throws on exhausted retries.
    const postResilient = async (path: string, body: unknown): Promise<PermissionReply> => {
      let failures = 0;
      for (;;) {
        try {
          const r = await postJson(path, body);
          if (!r.ok) {
            // A 4xx/5xx is a definite answer from the worker, not a blip — tag
            // it so the catch fails closed rather than spinning.
            const httpErr = new Error(r.body.error || `permission service returned HTTP ${r.status}`);
            (httpErr as { httpRejection?: boolean }).httpRejection = true;
            throw httpErr;
          }
          return r.body;
        } catch (err) {
          // A tagged HTTP rejection is a real answer — never retry it. A thrown
          // fetch (network blip) IS retried, up to a sustained streak.
          const isHttpRejection = !!(err as { httpRejection?: boolean })?.httpRejection;
          if (isHttpRejection || ++failures >= MAX_CONSECUTIVE_FAILURES) throw err;
          await sleep(backoffDelay(failures - 1));
        }
      }
    };

    try {
      const opened = await postResilient("/agent-ops/permission/request", {
        toolName: args.tool_name ?? "Tool",
        input: toolInput,
        toolUseId: args.tool_use_id,
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
        const reply = await postResilient("/agent-ops/permission/await", { requestId, timeoutMs: POLL_TIMEOUT_MS });
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
  });

  return server;
}

// Connect over stdio only when run as the entry point (the agent CLI spawns
// this file directly via `tsx`). Importing the module — e.g. from a test — must
// NOT touch stdin/stdout. Mirrors the guard in mcp-present-bridge.ts.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  await createPermissionBridgeServer().connect(new StdioServerTransport());
}
