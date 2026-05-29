/**
 * Minimal MCP client used by the session worker's `POST /mcp/test` endpoint
 * (docs/088-mcp-integration). Speaks just enough of the MCP JSON-RPC 2.0
 * protocol to perform `initialize` → `tools/list` and tear the connection
 * down. NOT a general-purpose MCP client — the agent's Claude CLI owns the
 * real connections; this exists purely for the connectivity-test UX.
 *
 * Configs passed here are already RESOLVED (no `$secret:` placeholders) — the
 * caller substitutes them against `process.env` first, same as each agent
 * adapter's `writeMcpConfig()`.
 */

import { spawn } from "node:child_process";
import type { McpServerConfig, McpTestResult, McpTool } from "../shared/types/mcp-types.js";
import { getErrorMessage } from "../shared/utils.js";

const TEST_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "shipit-mcp-test", version: "1.0.0" };

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Extract a tool list from a `tools/list` result payload. */
function parseTools(result: unknown): McpTool[] {
  const tools = (result as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t): t is { name: string; description?: string } =>
      !!t && typeof (t as { name?: unknown }).name === "string",
    )
    .map((t) => ({ name: t.name, description: t.description }));
}

/** Run `initialize` + `tools/list` against a server config. */
export async function testMcpServer(config: McpServerConfig): Promise<McpTestResult> {
  try {
    const tools =
      config.type === "stdio"
        ? await testStdioServer(config.command, config.args ?? [], config.env ?? {})
        : await testHttpServer(config.url, config.headers ?? {});
    return { ok: true, tools };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

/** Spawn a stdio MCP server, handshake, list tools, kill it. */
function testStdioServer(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<McpTool[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    let buffer = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      finish(() => reject(new Error("MCP server test timed out after 30s")));
    }, TEST_TIMEOUT_MS);

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      action();
    }

    function send(msg: unknown): void {
      try {
        proc.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    }

    proc.on("error", (err) => {
      finish(() => reject(new Error(`Failed to spawn "${command}": ${err.message}`)));
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("exit", (code) => {
      if (!settled) {
        finish(() =>
          reject(
            new Error(
              `MCP server exited (code ${code ?? "?"})${stderr ? `: ${stderr.trim().slice(-400)}` : ""}`,
            ),
          ),
        );
      }
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue; // server log noise on stdout — ignore
        }
        if (msg.id === 1) {
          if (msg.error) {
            finish(() => reject(new Error(`initialize failed: ${msg.error?.message}`)));
            return;
          }
          // Handshake complete — notify + request tools.
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          if (msg.error) {
            finish(() => reject(new Error(`tools/list failed: ${msg.error?.message}`)));
            return;
          }
          finish(() => resolve(parseTools(msg.result)));
          return;
        }
      }
    });

    // Kick off the handshake.
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    });
  });
}

/** Open a Streamable-HTTP MCP server, handshake, list tools. */
async function testHttpServer(
  url: string,
  headers: Record<string, string>,
): Promise<McpTool[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...headers,
    };

    const post = async (body: unknown): Promise<JsonRpcResponse> => {
      const res = await fetch(url, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const text = await res.text();
      // Streamable HTTP may answer with SSE framing (`data: {...}`) or plain
      // JSON. Pull the last JSON object out either way.
      const jsonLine = text
        .split("\n")
        .map((l) => l.replace(/^data:\s*/, "").trim())
        .filter((l) => l.startsWith("{"))
        .pop();
      if (!jsonLine) throw new Error("Empty response from MCP server");
      return JSON.parse(jsonLine) as JsonRpcResponse;
    };

    const initRes = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    });
    if (initRes.error) throw new Error(`initialize failed: ${initRes.error.message}`);

    const toolsRes = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    if (toolsRes.error) throw new Error(`tools/list failed: ${toolsRes.error.message}`);
    return parseTools(toolsRes.result);
  } finally {
    clearTimeout(timer);
  }
}
