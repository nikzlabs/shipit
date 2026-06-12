/**
 * Unit tests for the `permission_prompt` MCP bridge (docs/193, Thread B).
 *
 * The bridge is pure transport: it forwards a gated tool call to the worker's
 * PermissionBroker as a long poll (open → poll /await until answered) and maps
 * the decision back to the CLI's allow/deny envelope. These tests wire the
 * bridge's `Server` to an in-memory transport pair, drive `CallTool` through a
 * real MCP `Client`, and stub `globalThis.fetch` so we can script the
 * worker-up / worker-blip / worker-down paths without a live worker. The retry
 * backoff is made instant by injecting a no-op `sleep`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPermissionBridgeServer } from "./mcp-permission-bridge.js";

const WORKER = `http://127.0.0.1:${process.env.WORKER_PORT || "9100"}`;
const REQUEST_URL = `${WORKER}/agent-ops/permission/request`;
const AWAIT_URL = `${WORKER}/agent-ops/permission/await`;

/** Build a stub `fetch` Response with the given status + JSON body. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

async function connectBridge(): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // Instant backoff so the resilience tests don't wait real seconds.
  const server = createPermissionBridgeServer({ sleep: () => Promise.resolve() });
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

/** Drive the tool and parse the JSON envelope the bridge returns. */
async function callPermission(client: Client, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name: "permission_prompt", arguments: args })) as {
    content: { type: string; text: string }[];
  };
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

describe("mcp-permission-bridge", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("opens, polls, and maps an allow to an allow envelope (echoing updatedInput)", async () => {
    const { client, close } = await connectBridge();
    const input = { file_path: ".npmrc" };
    fetchMock.mockImplementation((url: string) => {
      if (url === REQUEST_URL) return Promise.resolve(jsonResponse(200, { requestId: "perm_1" }));
      if (url === AWAIT_URL) return Promise.resolve(jsonResponse(200, { behavior: "allow" }));
      throw new Error(`unexpected url ${url}`);
    });

    const envelope = await callPermission(client, { tool_name: "Write", input, tool_use_id: "tu-1" });
    expect(envelope).toEqual({ behavior: "allow", updatedInput: input });
    await close();
  });

  it("returns an inline pre-approval without polling /await", async () => {
    const { client, close } = await connectBridge();
    fetchMock.mockImplementation((url: string) => {
      if (url === REQUEST_URL) return Promise.resolve(jsonResponse(200, { behavior: "allow" }));
      throw new Error(`should not poll /await on an inline decision (got ${url})`);
    });

    const envelope = await callPermission(client, { tool_name: "ExitPlanMode", input: {} });
    expect(envelope).toEqual({ behavior: "allow", updatedInput: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await close();
  });

  it("loops on { pending: true } until the user answers (no failure on a slow user)", async () => {
    const { client, close } = await connectBridge();
    let polls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url === REQUEST_URL) return Promise.resolve(jsonResponse(200, { requestId: "perm_2" }));
      if (url === AWAIT_URL) {
        polls += 1;
        return Promise.resolve(
          polls < 3 ? jsonResponse(200, { pending: true }) : jsonResponse(200, { behavior: "deny", message: "no" }),
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const envelope = await callPermission(client, { tool_name: "Write", input: { file_path: ".env" }, tool_use_id: "tu-2" });
    expect(envelope).toEqual({ behavior: "deny", message: "no" });
    expect(polls).toBe(3);
    await close();
  });

  it("rides over a transient fetch failure with retry instead of failing closed", async () => {
    const { client, close } = await connectBridge();
    let attempts = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url === REQUEST_URL) {
        attempts += 1;
        // First open attempt is a transient network blip; the retry succeeds.
        if (attempts === 1) return Promise.reject(new TypeError("fetch failed"));
        return Promise.resolve(jsonResponse(200, { requestId: "perm_3" }));
      }
      if (url === AWAIT_URL) return Promise.resolve(jsonResponse(200, { behavior: "allow" }));
      throw new Error(`unexpected url ${url}`);
    });

    const input = { file_path: ".npmrc" };
    const envelope = await callPermission(client, { tool_name: "Write", input, tool_use_id: "tu-3" });
    expect(envelope).toEqual({ behavior: "allow", updatedInput: input });
    expect(attempts).toBe(2);
    await close();
  });

  it("fails closed with the canonical message after sustained unreachability", async () => {
    const { client, close } = await connectBridge();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const envelope = await callPermission(client, { tool_name: "Write", input: { file_path: ".npmrc" }, tool_use_id: "tu-4" });
    expect(envelope.behavior).toBe("deny");
    expect(String(envelope.message)).toContain("Permission request could not reach the worker");
    await close();
  });

  it("fails closed immediately (no spin) on a 4xx/5xx broker rejection", async () => {
    const { client, close } = await connectBridge();
    let calls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url === REQUEST_URL) {
        calls += 1;
        return Promise.resolve(jsonResponse(500, { error: "broker exploded" }));
      }
      throw new Error(`unexpected url ${url}`);
    });

    const envelope = await callPermission(client, { tool_name: "Write", input: { file_path: ".npmrc" }, tool_use_id: "tu-5" });
    expect(envelope.behavior).toBe("deny");
    expect(String(envelope.message)).toContain("broker exploded");
    // A definite HTTP rejection is not retried.
    expect(calls).toBe(1);
    await close();
  });
});
