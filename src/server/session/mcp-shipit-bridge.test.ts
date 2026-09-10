import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createShipitBridgeServer, selectTools, TOOL_REGISTRY } from "./mcp-shipit-bridge.js";
import type { ToolDescriptor } from "./mcp-tools/types.js";

const WORKER = "http://worker.test";
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

function firstText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

describe("selectTools", () => {
  it("parses a comma-separated spec into the matching descriptors, in order", () => {
    const ids = selectTools("voice,permission,present").map((t) => t.id);
    expect(ids).toEqual(["voice", "permission", "present"]);
  });

  it("trims whitespace and drops unknown / empty ids", () => {
    const ids = selectTools(" voice , bogus ,, present ").map((t) => t.id);
    expect(ids).toEqual(["voice", "present"]);
  });

  it("returns an empty list for an undefined or empty spec", () => {
    expect(selectTools(undefined)).toEqual([]);
    expect(selectTools("")).toEqual([]);
  });

  it("registers all internal tools", () => {
    expect(Object.keys(TOOL_REGISTRY).sort()).toEqual(
      ["ask", "bug", "permission", "present", "propose_actions", "voice"],
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
    bridge = await connect(selectTools("present,voice,bug,permission,propose_actions"));
    const { tools } = await bridge.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["permission_prompt", "present", "propose_actions", "report_shipit_bug", "voice_note"],
    );
    expect(tools.find((t) => t.name === "AskUserQuestion")).toBeUndefined();
  });

  it("declares the option bound `AskUserQuestion` actually enforces", async () => {
    bridge = await connect(selectTools("ask"));
    const askSchema = (await bridge.client.listTools()).tools.find(
      (t) => t.name === "AskUserQuestion",
    )?.inputSchema as {
      properties?: { questions?: { minItems?: number; items?: { properties?: { options?: { minItems?: number } } } } };
    };

    expect(askSchema?.properties?.questions?.minItems).toBe(1);
    expect(askSchema?.properties?.questions?.items?.properties?.options?.minItems).toBe(1);

    const result = await bridge.client.callTool({
      name: "AskUserQuestion",
      arguments: { questions: [{ question: "Which?", header: "Pick", options: [] }] },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("rejects a blank-labelled option in-box, not after a round trip", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    bridge = await connect(selectTools("ask"));

    const result = await bridge.client.callTool({
      name: "AskUserQuestion",
      arguments: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "" }] }] },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes a different subset for Codex (ask, no permission)", async () => {
    bridge = await connect(selectTools("present,voice,ask,bug,propose_actions"));
    const names = (await bridge.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("AskUserQuestion");
    expect(names).toContain("propose_actions");
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
      arguments: { summary: "Done." },
    });

    expect(fetchMock).toHaveBeenCalledWith(`${WORKER}/agent-ops/voice/note`, expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(firstText(result))).toEqual({ status: "delivered", delivered: true });
  });

  it("treats a missing `delivered` field as not delivered (no success masking)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));
    bridge = await connect(selectTools("voice"));

    const result = await bridge.client.callTool({
      name: "voice_note",
      arguments: { summary: "Done." },
    });
    expect(JSON.parse(firstText(result))).toEqual({ status: "not_delivered", delivered: false });
  });

  it("forwards `propose_actions` to the worker and confirms the posted count", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, cardId: "action-card-1", count: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    bridge = await connect(selectTools("propose_actions"));

    const result = await bridge.client.callTool({
      name: "propose_actions",
      arguments: {
        title: "Optional follow-ups",
        actions: [
          { id: "a1", label: "Open a PR", payload: "Open a PR for this change." },
          { id: "a2", label: "File issue", payload: "File a follow-up issue." },
        ],
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${WORKER}/agent-ops/propose-actions`,
      expect.objectContaining({ method: "POST" }),
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(firstText(result)).toContain("2 actions");
  });

  it("fails `propose_actions` fast on an empty actions array without hitting the worker", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    bridge = await connect(selectTools("propose_actions"));

    const result = await bridge.client.callTool({ name: "propose_actions", arguments: { actions: [] } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails `propose_actions` fast on an over-long payload, naming the size and the fix", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    bridge = await connect(selectTools("propose_actions"));

    const result = await bridge.client.callTool({
      name: "propose_actions",
      arguments: { actions: [{ id: "a1", label: "Open a PR", payload: "x".repeat(4200) }] },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(firstText(result)).toContain("4200 chars");
    expect(firstText(result)).toContain("4000");
    expect(firstText(result)).toMatch(/call propose_actions again/);
  });

  it("surfaces the orchestrator's validation error to the model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "Duplicate action id \"dup\"" })));
    bridge = await connect(selectTools("propose_actions"));

    const result = await bridge.client.callTool({
      name: "propose_actions",
      arguments: { actions: [{ id: "dup", label: "L", payload: "P" }] },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(firstText(result)).toContain("Duplicate action id");
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
      .mockResolvedValueOnce(jsonResponse(200, { requestId: "req-1" }))
      .mockResolvedValueOnce(jsonResponse(200, { pending: true }))
      .mockResolvedValueOnce(jsonResponse(200, { behavior: "allow" }));
    vi.stubGlobal("fetch", fetchMock);
    bridge = await connect(selectTools("permission"));

    const result = await bridge.client.callTool({
      name: "permission_prompt",
      arguments: { tool_name: "Edit", input: { file_path: ".env" }, tool_use_id: "tu-1" },
    });

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
