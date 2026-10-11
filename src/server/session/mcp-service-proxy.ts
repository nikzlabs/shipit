/**
 * docs/327-service-mcp-servers — a stdio MCP server the agent launches for one
 * MCP server on a Compose service. It answers the agent at once and forwards the
 * service's tools once the service answers, so an agent that starts before the
 * service, or outlives a restart of it, still gets the tools.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

// McpError carries a plain number; ErrorCode is an enum. The SDK raises both of
// these itself, so neither is an answer from the service.
const NO_ANSWER_CODES: readonly number[] = [ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout];

export interface ServiceProxyTiming {
  /** How long the agent's first tools/list waits for the first connection attempt. */
  firstListWaitMs: number;
  retryMinMs: number;
  retryMaxMs: number;
  /** How often a reachable service's tool list is read again. */
  refreshMs: number;
  connectTimeoutMs: number;
  callTimeoutMs: number;
}

export const DEFAULT_SERVICE_PROXY_TIMING: ServiceProxyTiming = {
  // Below the MCP start-up deadlines of the per-turn CLIs.
  firstListWaitMs: 3_000,
  retryMinMs: 1_000,
  retryMaxMs: 15_000,
  refreshMs: 60_000,
  connectTimeoutMs: 5_000,
  callTimeoutMs: 15 * 60_000,
};

export interface ServiceProxy {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  server: Server;
  start(): void;
  stop(): Promise<void>;
}

export function createServiceProxy(
  url: string,
  timing: ServiceProxyTiming = DEFAULT_SERVICE_PROXY_TIMING,
  log: (line: string) => void = (line) => process.stderr.write(`[mcp-service-proxy] ${line}\n`),
): ServiceProxy {
  const service = new URL(url).hostname;
  // Low-level Server accepts JSON Schema without a direct zod dependency.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: "shipit-service-proxy", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  let client: Client | null = null;
  let opening: Client | null = null;
  let tools: Tool[] = [];
  let listed = false;
  let reachable = false;
  let stopped = false;
  let retryMs = timing.retryMinMs;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  const schedule = (ms: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void sync();
    }, ms);
    timer.unref();
  };

  const drop = (err: unknown): void => {
    if (reachable) log(`lost ${url}: ${describe(err)}`);
    reachable = false;
    const old = client;
    client = null;
    if (old) void old.close().catch(() => undefined);
  };

  const setTools = (next: Tool[]): void => {
    const changed = JSON.stringify(next) !== JSON.stringify(tools);
    tools = next;
    // An agent that has not listed yet reads the new list when it asks.
    if (changed && listed) void server.sendToolListChanged().catch(() => undefined);
  };

  const openClient = async (): Promise<Client> => {
    const c = new Client({ name: "shipit-service-proxy", version: "1.0.0" });
    // A broken stream after a restart; the next request reports it.
    c.onerror = () => undefined;
    opening = c;
    try {
      // The SDK's timeout covers `initialize` only, not the notification it posts after.
      await within(
        c.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: timing.connectTimeoutMs }),
        timing.connectTimeoutMs,
      );
      return c;
    } catch (err) {
      void c.close().catch(() => undefined);
      throw err;
    } finally {
      opening = null;
    }
  };

  const listAll = async (c: Client): Promise<Tool[]> => {
    const all: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.listTools(cursor ? { cursor } : undefined, { timeout: timing.connectTimeoutMs });
      all.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  };

  const runSync = async (): Promise<void> => {
    try {
      client ??= await openClient();
      const next = await listAll(client);
      if (stopped) throw new Error("stopped");
      if (!reachable) log(`connected to ${url} (${next.length} tools)`);
      reachable = true;
      retryMs = timing.retryMinMs;
      setTools(next);
      schedule(timing.refreshMs);
    } catch (err) {
      drop(err);
      schedule(retryMs);
      retryMs = Math.min(retryMs * 2, timing.retryMaxMs);
    }
  };

  const sync = (): Promise<void> => {
    inFlight ??= runSync().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const unreachable = (detail: string): CallToolResult => ({
    content: [{
      type: "text",
      text: `The \`${service}\` service did not answer at ${url} (${detail}). It may be starting, `
        + "restarting or stopped: `shipit service list` shows its state. Call the tool again when it runs.",
    }],
    isError: true,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!listed && inFlight) await Promise.race([inFlight, delay(timing.firstListWaitMs)]);
    listed = true;
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    if (!client) await sync();
    const c = client;
    if (!c) return unreachable("no connection");
    try {
      return await c.request(
        { method: "tools/call", params: req.params },
        CallToolResultSchema,
        { signal: extra.signal, timeout: timing.callTimeoutMs },
      );
    } catch (err) {
      if (extra.signal.aborted) throw err;
      // The service answered with an error, so the connection is fine.
      if (err instanceof McpError && !NO_ANSWER_CODES.includes(err.code)) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      // Not retried: the service can have done the work before the connection broke.
      drop(err);
      retryMs = timing.retryMinMs;
      schedule(retryMs);
      return unreachable(describe(err));
    }
  });

  return {
    server,
    start: () => {
      void sync();
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const old = client ?? opening;
      client = null;
      await old?.close().catch(() => undefined);
    },
  };
}

async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer in ${ms} ms`));
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  // fetch hides the network reason (ECONNREFUSED, ENOTFOUND) in `cause`.
  return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const url = process.argv[2];
  if (!url || !URL.canParse(url)) {
    process.stderr.write("usage: mcp-service-proxy <url>\n");
    process.exit(2);
  }
  const proxy = createServiceProxy(url);
  await proxy.server.connect(new StdioServerTransport());
  proxy.start();
  // The agent closing stdin is the end of this server; open sockets must not keep it.
  process.stdin.on("end", () => process.exit(0));
}
