// Minimal stdio MCP server for the Antigravity probe. One tool, named by argv[2].
// Newline-delimited JSON-RPC, as the MCP stdio transport specifies.
const toolName = process.argv[2] || "echo_probe";
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: (params && params.protocolVersion) || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: `probe-${toolName}`, version: "0.0.1" },
    } });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{
      name: toolName,
      description: `Probe tool ${toolName}: returns the given text wrapped in brackets.`,
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    }] } });
  } else if (method === "tools/call") {
    const text = (params && params.arguments && params.arguments.text) || "";
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `[${toolName}:${text}]` }] } });
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}
