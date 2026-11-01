import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServiceProxy, type ServiceProxy, type ServiceProxyTiming } from "./mcp-service-proxy.js";

const FAST: ServiceProxyTiming = {
  firstListWaitMs: 1_000,
  retryMinMs: 20,
  retryMaxMs: 100,
  refreshMs: 60_000,
  connectTimeoutMs: 1_000,
  callTimeoutMs: 5_000,
};

/** A stateless Streamable HTTP MCP server, as a plugin's service would run one. */
function startService(
  port: number,
  toolNames: string[],
  /** Requests with this JSON-RPC method get no answer while it is set. */
  stalled: { method?: string } = {},
): Promise<http.Server> {
  const httpServer = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const mcp = new Server({ name: "service", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({
      tools: toolNames.map((name) => ({ name, inputSchema: { type: "object" as const } })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, (call) => {
      if (call.params.name === "refuse") throw new McpError(ErrorCode.InvalidParams, "no such verse");
      return Promise.resolve({
        content: [{ type: "text" as const, text: `${call.params.name} ${JSON.stringify(call.params.arguments)}` }],
      });
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method?: string };
      if (stalled.method !== undefined && body.method === stalled.method) return;
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })();
  });
  return new Promise((resolve) => httpServer.listen(port, "127.0.0.1", () => resolve(httpServer)));
}

function stopService(httpServer: http.Server): Promise<void> {
  httpServer.closeAllConnections();
  return new Promise((resolve) => httpServer.close(() => resolve()));
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const cleanup: (() => Promise<void>)[] = [];

// Vitest does not fail a run on an unhandled rejection, so record them here.
const stray: unknown[] = [];
const recordStray = (err: unknown): void => {
  stray.push(err);
};
beforeAll(() => {
  process.on("unhandledRejection", recordStray);
  process.on("uncaughtException", recordStray);
});
afterAll(() => {
  process.off("unhandledRejection", recordStray);
  process.off("uncaughtException", recordStray);
  expect(stray).toEqual([]);
});

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function connectAgent(proxy: ServiceProxy): Promise<{ agent: Client; listChanged: () => Promise<void> }> {
  const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(proxySide);
  const agent = new Client({ name: "agent", version: "1.0.0" });
  let notify: (() => void) | null = null;
  agent.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    notify?.();
  });
  await agent.connect(agentSide);
  cleanup.push(() => agent.close());
  return {
    agent,
    listChanged: () => new Promise<void>((resolve) => {
      notify = resolve;
    }),
  };
}

function startProxy(
  url: string,
  timing: ServiceProxyTiming = FAST,
  log: (line: string) => void = () => undefined,
): ServiceProxy {
  const proxy = createServiceProxy(url, timing, log);
  cleanup.push(() => proxy.stop());
  proxy.start();
  return proxy;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("");
}

describe("mcp-service-proxy (docs/327)", () => {
  it("gives the agent the service's tools at its first list when the service already runs", async () => {
    const port = await freePort();
    const service = await startService(port, ["render", "search"]);
    cleanup.push(() => stopService(service));

    const { agent } = await connectAgent(startProxy(`http://127.0.0.1:${port}/mcp`));

    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name)).toEqual(["render", "search"]);
  });

  it("answers the agent before the service starts, then announces the tools when it does", async () => {
    const port = await freePort();
    const { agent, listChanged } = await connectAgent(
      startProxy(`http://127.0.0.1:${port}/mcp`, { ...FAST, firstListWaitMs: 50 }),
    );

    expect((await agent.listTools()).tools).toEqual([]);

    const changed = listChanged();
    const service = await startService(port, ["render"]);
    cleanup.push(() => stopService(service));
    await changed;

    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(["render"]);
  });

  it("forwards a call's arguments and returns the service's result", async () => {
    const port = await freePort();
    const service = await startService(port, ["render"]);
    cleanup.push(() => stopService(service));
    const { agent } = await connectAgent(startProxy(`http://127.0.0.1:${port}/mcp`));
    await agent.listTools();

    const result = await agent.callTool({ name: "render", arguments: { verse: "John 3:16" } });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('render {"verse":"John 3:16"}');
  });

  it("reports a stopped service as a tool error, and works again after the service restarts", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/mcp`;
    let service = await startService(port, ["render"]);
    const { agent } = await connectAgent(startProxy(url));
    await agent.listTools();

    await stopService(service);
    const down = await agent.callTool({ name: "render", arguments: {} });
    expect(down.isError).toBe(true);
    expect(textOf(down)).toContain(url);
    expect(textOf(down)).toContain("shipit service list");
    // The last list stays, so the agent can call again once the service is back.
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(["render"]);

    service = await startService(port, ["render"]);
    cleanup.push(() => stopService(service));

    const up = await agent.callTool({ name: "render", arguments: {} });
    expect(up.isError).toBeFalsy();
  });

  it("announces a tool list that a restart changed", async () => {
    const port = await freePort();
    const first = await startService(port, ["render"]);
    const { agent, listChanged } = await connectAgent(
      startProxy(`http://127.0.0.1:${port}/mcp`, { ...FAST, refreshMs: 50 }),
    );
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(["render"]);

    await stopService(first);
    const changed = listChanged();
    const second = await startService(port, ["render", "share"]);
    cleanup.push(() => stopService(second));
    await changed;

    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(["render", "share"]);
  });

  it("returns the service's own error for a call it refuses, and keeps the connection", async () => {
    const port = await freePort();
    const service = await startService(port, ["render", "refuse"]);
    cleanup.push(() => stopService(service));
    const lines: string[] = [];
    const { agent } = await connectAgent(startProxy(`http://127.0.0.1:${port}/mcp`, FAST, (l) => lines.push(l)));
    await agent.listTools();

    const refused = await agent.callTool({ name: "refuse", arguments: {} });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("no such verse");
    expect(lines.filter((l) => l.startsWith("lost"))).toEqual([]);
  });

  it("does not wait for ever on a handshake that the service leaves half done", async () => {
    const port = await freePort();
    const stalled: { method?: string } = { method: "notifications/initialized" };
    const service = await startService(port, ["render"], stalled);
    cleanup.push(() => stopService(service));
    const { agent, listChanged } = await connectAgent(
      startProxy(`http://127.0.0.1:${port}/mcp`, { ...FAST, firstListWaitMs: 50, connectTimeoutMs: 100 }),
    );
    expect((await agent.listTools()).tools).toEqual([]);

    const changed = listChanged();
    await new Promise((r) => setTimeout(r, 300));
    delete stalled.method;
    await changed;

    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(["render"]);
  });

  it("treats a call the service never answers as a lost connection, with the service's address", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/mcp`;
    const stalled: { method?: string } = {};
    const service = await startService(port, ["render"], stalled);
    cleanup.push(() => stopService(service));
    const lines: string[] = [];
    const { agent } = await connectAgent(startProxy(url, { ...FAST, callTimeoutMs: 150 }, (l) => lines.push(l)));
    await agent.listTools();

    stalled.method = "tools/call";
    const silent = await agent.callTool({ name: "render", arguments: {} });
    expect(silent.isError).toBe(true);
    expect(textOf(silent)).toContain(url);
    expect(textOf(silent)).toContain("shipit service list");
    expect(lines.some((l) => l.startsWith("lost"))).toBe(true);

    delete stalled.method;
    const again = await agent.callTool({ name: "render", arguments: {} });
    expect(again.isError).toBeFalsy();
  });
});
