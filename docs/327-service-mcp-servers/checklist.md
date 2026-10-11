# 327 — checklist

- [x] `shared/service-mcp.ts`: the declaration form (name, path, URL)
- [x] Manifest: `exports.plugins.<name>.mcp` in `parseExportEntry`, with tests
- [x] Project: top-level `mcp` in `parseShipitConfig`, with tests
- [x] `collectPluginFragments`: resolve each plugin server to its service and port; advisory `mcpIssuesByRepo`; tests
- [x] Plugins card and `shipit plugin status` show the MCP rows
- [x] `PluginComposeService.mcp` and `ServiceManager.pluginMcpServers()`
- [x] `resolveServiceMcp` (project and plugin servers, collisions, candidate names), with tests
- [x] `buildAgentRunParams`: `serviceMcpServers`, `serviceMcpCandidates`, the record of the set
- [x] `releaseResidentOnServiceMcpChange`, wired on the interactive and the dispatched path, with tests
- [x] Worker: `withServiceMcpServers` turns each server into a stdio proxy entry, which takes the name from an account server that has it too; with tests
- [x] `mcp-service-proxy.ts`: connect, poll, `tools/list_changed`, call forwarding, with tests against a real Streamable HTTP server
- [x] Bundle the proxy in `scripts/build-mcp-bridges.mjs`, with a bundle smoke test
- [x] Docs: `plugins.md`, `plugin-authoring.md`, `shipit-yaml.md`, the wiki's plugins page
- [x] A resident Claude takes a server that is declared after it started: `syncServiceMcp`, `POST /agent/service-mcp`, `setLiveMcpServers` (`mcp_set_servers`), allowlist candidates; with tests
- [x] Review findings: one deadline for the proxy's handshake, a timed-out call is a lost connection, MCP names go to admitted repositories only
- [x] Second review: a start carries the set of the moment it is posted, sync calls run in order and ignore an answer about a replaced process, a turn with no record asks the worker
- [x] Independent review against the requirements (two rounds; the open question in `requirements.md` is its remaining point)
