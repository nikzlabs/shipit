/**
 * Unit tests for the `present` MCP bridge (docs/093).
 *
 * The bridge is pure transport: it exposes a single `present` tool over MCP and
 * forwards each call to the session worker's `/agent-ops/present/submit` broker,
 * relaying the worker's response back as the tool result. These tests wire the
 * bridge's `Server` to an in-memory transport pair and drive `ListTools` /
 * `CallTool` through a real MCP `Client`, with `globalThis.fetch` stubbed so we
 * can assert the forwarded body and exercise the worker-up / worker-down paths
 * without a live worker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPresentBridgeServer } from "./mcp-present-bridge.js";

// The bridge computes its worker URL from WORKER_PORT (defaulting to 9100) at
// module load — recompute the expected value the same way so the assertion is
// independent of whatever the test environment happens to set.
const EXPECTED_SUBMIT_URL = `http://127.0.0.1:${process.env.WORKER_PORT || "9100"}/agent-ops/present/submit`;

/** Connect a fresh bridge server to a Client over a linked in-memory pair. */
async function connectBridge(): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createPresentBridgeServer();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Build a stub `fetch` Response with the given status + JSON body. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("mcp-present-bridge", () => {
  let bridge: { client: Client; close: () => Promise<void> };

  beforeEach(async () => {
    bridge = await connectBridge();
  });

  afterEach(async () => {
    await bridge.close();
    vi.restoreAllMocks();
  });

  it("ListTools returns the single `present` tool with the expected schema", async () => {
    const { tools } = await bridge.client.listTools();
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe("present");
    expect(typeof tool.description).toBe("string");
    expect(tool.description).toBeTruthy();

    const schema = tool.inputSchema;
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["content", "mimeType", "replaceId", "title"]);
    // `content` is the only required field; mimeType/title/replaceId are optional.
    expect(schema.required).toEqual(["content"]);
  });

  it("CallTool forwards args to the worker and relays { status, presentId }", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { presentId: "pres_123", status: "presented" }));

    const result = await bridge.client.callTool({
      name: "present",
      arguments: { content: "<p>hi</p>", mimeType: "text/html" },
    });

    // Forwarded as a JSON POST to the worker's submit broker.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(EXPECTED_SUBMIT_URL);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({
      content: "<p>hi</p>",
      mimeType: "text/html",
      title: undefined,
      replaceId: undefined,
    });

    // Relayed back as a single text content block carrying JSON.
    expect(result.isError).toBeFalsy();
    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    const relayed = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(relayed).toEqual({ status: "presented", presentId: "pres_123" });
    // title / replaceId omitted from the relay when not passed by the caller.
    expect(relayed).not.toHaveProperty("title");
    expect(relayed).not.toHaveProperty("replaceId");
  });

  it("includes title and replaceId in the relay only when passed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { presentId: "pres_456", status: "presented" }),
    );

    const result = await bridge.client.callTool({
      name: "present",
      arguments: {
        content: "<svg/>",
        mimeType: "image/svg+xml",
        title: "Diagram v2",
        replaceId: "pres_123",
      },
    });

    const content = result.content as { type: string; text: string }[];
    const relayed = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(relayed).toEqual({
      status: "presented",
      presentId: "pres_456",
      title: "Diagram v2",
      replaceId: "pres_123",
    });
  });

  it("defaults status to 'presented' when the worker omits it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { presentId: "pres_789" }));

    const result = await bridge.client.callTool({
      name: "present",
      arguments: { content: "<p>x</p>" },
    });

    const content = result.content as { type: string; text: string }[];
    const relayed = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(relayed.status).toBe("presented");
    expect(relayed.presentId).toBe("pres_789");
  });

  it("surfaces isError with the worker's error text on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(413, { error: "Content too large for inline presentation" }),
    );

    const result = await bridge.client.callTool({
      name: "present",
      arguments: { content: "x".repeat(100) },
    });

    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0].text).toContain("present failed");
    expect(content[0].text).toContain("Content too large for inline presentation");
  });

  it("falls back to an HTTP-status message when a non-OK response has no error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(500, {}));

    const result = await bridge.client.callTool({
      name: "present",
      arguments: { content: "<p>x</p>" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0].text).toContain("HTTP 500");
  });

  it("surfaces isError with a 'could not reach the worker' message when fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await bridge.client.callTool({
      name: "present",
      arguments: { content: "<p>x</p>" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0].text).toContain("could not reach the worker");
    expect(content[0].text).toContain("ECONNREFUSED");
  });

  it("returns isError for an unknown tool name without calling fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await bridge.client.callTool({ name: "bogus", arguments: {} });

    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0].text).toContain("Unknown tool: bogus");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
