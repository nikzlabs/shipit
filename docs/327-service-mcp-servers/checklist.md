# 327 — checklist

- [x] `shared/service-mcp.ts`: the declaration form (name, path, URL)
- [x] Manifest: `exports.plugins.<name>.mcp` in `parseExportEntry`, with tests
- [x] Project: top-level `mcp` in `parseShipitConfig`, with tests
- [x] `collectPluginFragments`: resolve each plugin server to its service and port; advisory `mcpIssuesByRepo`; tests
- [x] Plugins card and `shipit plugin status` show the MCP rows
- [x] `PluginComposeService.mcp` and `ServiceManager.pluginMcpServers()`
- [x] `resolveServiceMcpServers` (project and plugin servers, collisions), with tests
- [x] `buildAgentRunParams`: `serviceMcpServers`, account server with a declared name left out, spawn record
- [x] `releaseResidentOnServiceMcpChange`, wired on the interactive and the dispatched path, with tests
- [x] Worker: `withServiceMcpServers` turns each server into a stdio proxy entry, with tests
- [x] `mcp-service-proxy.ts`: connect, poll, `tools/list_changed`, call forwarding, with tests against a real Streamable HTTP server
- [x] Bundle the proxy in `scripts/build-mcp-bridges.mjs`, with a bundle smoke test
- [x] Docs: `plugins.md`, `plugin-authoring.md`, `shipit-yaml.md`, the wiki's plugins page
- [ ] Independent review against the requirements
