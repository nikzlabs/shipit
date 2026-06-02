# Checklist — Codex AskUserQuestion bridge

- [x] New `mcp-ask-bridge.ts` exposing a Claude-compatible `AskUserQuestion` tool
- [x] `AgentMcpAskBridge` type + `askBridge` on `AgentMcpWriteContext`
- [x] Worker resolves + passes `askBridgePaths()` into `writeMcpConfig`
- [x] Codex adapter registers `[mcp_servers.shipit-ask]`
- [x] Codex adapter re-emits the ask tool call as a normalized `AskUserQuestion` tool_use
- [x] Codex `capabilities.toolNames` + tool-map updated
- [x] Adapter unit tests (normalize, defaults, no tool_result on completed, non-ask passthrough)
- [x] writeMcpConfig tests for the `shipit-ask` block
- [x] Design doc updated to the bridge approach
- [x] Claude behavior unchanged (ignores `askBridge`; native tool intact)

## Residual / future

- [ ] Live end-to-end verification against a real Codex app-server in a
      deployed container (MCP tool surfacing + `thread/resume` after the
      interrupt abandons the pending tool call).
