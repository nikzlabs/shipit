import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createShipitBridgeServer, selectTools, TOOL_REGISTRY } from "./mcp-shipit-bridge.js";
import type { ToolDescriptor } from "./mcp-tools/types.js";

/**
 * SHI-128 — the consolidated `shipit` bridge serves a configurable subset of all
 * internal tools from ONE stdio process. These tests drive a real MCP `Client`
 * over an in-memory transport, with `globalThis.fetch` stubbed, so they exercise
 * the production ListTools/CallTool path: tool selection, per-tool dispatch and
 * forwarding, the permission tool's resilient request→await poll, and the unknown
 * tool guard.
 */

const WORKER = "http://worker.test";
/** Instant backoff so the permission retry/poll loop doesn't actually sleep. */
const deps = { workerUrl: WORKER, sleep: () => Promise.resolve() };

async function connect(tools: ToolDescriptor[]): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createShipitBridgeServer(tools, deps);
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Extract the text of the first content block of a CallTool result. */
function firstText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

describe("selectTools", () => {
  it("parses a comma-separated spec into the matching descriptors, in order", () => {
    const ids = selectTools("review,voice,permission").map((t) => t.id);
    expect(ids).toEqual(["review", "voice", "permission"]);
  });

  it("trims whitespace and drops unknown / empty ids", () => {
    const ids = selectTools(" review , bogus ,, present ").map((t) => t.id);
    expect(ids).toEqual(["review", "present"]);
  });

  it("returns an empty list for an undefined or empty spec", () => {
    expect(selectTools(undefined)).toEqual([]);
    expect(selectTools("")).toEqual([]);
  });

  it("registers all six internal tools", () => {
    expect(Object.keys(TOOL_REGISTRY).sort()).toEqual(
      ["ask", "bug", "permission", "present", "review", "voice"],
    );
  });
});

describe("createShipitBridgeServer — ListTools", () => {
  let bridge: { client: Client; close: () => Promise<void> };
  afterEach(async () => {
    await bridge.close();
    vi.restoreAllMocks();
  });

  it("advertises exactly the selected tools under their MCP names", async () => {
    bridge = await connect(selectTools("review,present,voice,bug,permission"));
    const { tools } = await bridge.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["permission_prompt", "present", "report_shipit_bug", "submit_review", "voice_note"],
    );
    // ask was not selected.
    expect(tools.find((t) => t.name === "AskUserQuestion")).toBeUndefined();
  });

  it("exposes a different subset for Codex (ask, no permission)", async () => {
    bridge = await connect(selectTools("review,present,voice,ask,bug"));
    const names = (await bridge.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("AskUserQuestion");
    expect(names).not.toContain("permission_prompt");
  });
});

describe("createShipitBridgeServer — CallTool dispatch", () => {
  let bridge: { client: Client; close: () => Promise<void> };
  afterEach(async () => {
    await bridge.close();
    vi.restoreAllMocks();
  });

  it("forwards `voice_note` to the worker and reports the real delivered outcome", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { delivered: true }));
    vi.stubGlobal("fetch", fetchMock);
    bridge = await connect(selectTools("voice"));

    const result = await bridge.client.callTool({
      name: "voice_note",
      arguments: { summary: "Done.", needsAttention: false },
    });

    expect(fetchMock).toHaveBeenCalledWith(`${WORKER}/agent-ops/voice/note`, expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(firstText(result))).toEqual({ status: "delivered", delivered: true });
  });

  it("treats a missing `delivered` field as not delivered (no success masking)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));
    bridge = await connect(selectTools("voice"));

    const result = await bridge.client.callTool({
      name: "voice_note",
      arguments: { summary: "Done.", needsAttention: false },
    });
    expect(JSON.parse(firstText(result))).toEqual({ status: "not_delivered", delivered: false });
  });

  it("returns an unknown-tool error for a name the selected subset doesn't include", async () => {
    bridge = await connect(selectTools("voice"));
    const result = await bridge.client.callTool({ name: "permission_prompt", arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(firstText(result)).toContain("Unknown tool: permission_prompt");
  });
});

describe("permission tool — resilient request → await poll", () => {
  let bridge: { client: Client; close: () => Promise<void> };
  afterEach(async () => {
    await bridge.close();
    vi.restoreAllMocks();
  });

  it("opens the request, polls past `pending`, and returns an allow envelope", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { requestId: "req-1" })) // /request
      .mockResolvedValueOnce(jsonResponse(200, { pending: true })) //       /await #1
      .mockResolvedValueOnce(jsonResponse(200, { behavior: "allow" })); // /await #2
    vi.stubGlobal("fetch", fetchMock);
    bridge = await connect(selectTools("permission"));

    const result = await bridge.client.callTool({
      name: "permission_prompt",
      arguments: { tool_name: "Edit", input: { file_path: ".env" }, tool_use_id: "tu-1" },
    });

    // `updatedInput` echoes the original input back (mandatory on allow).
    expect(JSON.parse(firstText(result))).toEqual({
      behavior: "allow",
      updatedInput: { file_path: ".env" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed (deny) on a 4xx broker rejection without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, { error: "nope" }));
    vi.stubGlobal("fetch", fetchMock);
    bridge = await connect(selectTools("permission"));

    const result = await bridge.client.callTool({
      name: "permission_prompt",
      arguments: { tool_name: "Edit", input: {}, tool_use_id: "tu-2" },
    });
    expect(JSON.parse(firstText(result)).behavior).toBe("deny");
    // A definite HTTP rejection is not retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
