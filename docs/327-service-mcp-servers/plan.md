---
issue: planning#686
title: MCP servers on a plugin's or a project's Compose service — design
description: The `mcp` key in a plugin manifest and in a project's shipit.yaml, the stdio proxy that gives the server to the agent, and when its tools arrive.
---

# 327 — MCP servers on a Compose service: design

Implements [`requirements.md`](./requirements.md).

## The shape

The agent never connects to the service itself. For each declared server,
ShipIt gives the agent one more **stdio** MCP server, `mcp-service-proxy`: a
small ShipIt program, built and launched like the `shipit` bridge. It answers
the agent at once, connects to the service over Streamable HTTP when the service
answers, and forwards the service's tools. When the service's tool list changes —
it answered for the first time, or a restart changed it — the proxy sends
`notifications/tools/list_changed` (req 6, 7, 8).

The orchestrator decides which servers a session has, at the one place every
agent spawn goes through (`buildAgentRunParams`), and sends them as
`AgentRunParams.serviceMcpServers: { name, url }[]`. The worker turns each into
an ordinary stdio entry in `params.mcpServers`, so all five adapters write it
with the code they already have for an account server, and Claude's allowlist
(`mcp__<name>__*`) covers it.

## Declarations (req 1, 2, 3)

A plugin, in its manifest:

```yaml
exports:
  plugins:
    verseshot:
      compose: plugins/verseshot/docker-compose.yml
      mcp:
        service: verseshot   # a service in that fragment, by its own name
        path: /mcp           # optional, default /mcp
```

A project, in its own `shipit.yaml`:

```yaml
mcp:
  verseshotdev:          # the server's name in the agent
    service: api
    port: 8787
    path: /mcp           # optional, default /mcp
```

Both forms share `service` and `path`. They differ in the two things that have a
different owner:

- **The name.** A plugin's server takes the plugin's name (req 9); a project
  names each of its servers, so its form is a mapping keyed by name. A plugin
  exports at most one server; a repository that needs two exports two plugins.
- **The port.** A plugin's service serves on the port the consuming project
  writes (`plugins.use[].overrides.services.<svc>.port`), because
  [docs/266-plugin-service-ports](../266-plugin-service-ports/requirements.md)
  req 2 gives that number to the consumer and never to ShipIt or the plugin. So
  the plugin form has no `port`, and a plugin server whose service has no port
  is not given to the agent — the Plugins card says so and names the key to set.
  A project owns its services and its ports, so its form names the port. It is
  required, not read from the compose file's `ports:`: then the URL follows from
  `shipit.yaml` alone, with no read of the compose file at spawn time and no
  race against the stack's first start, and a service with no published port
  (an `expose:`-only API) can still carry a server.

The URL is `http://<compose service name>:<port><path>` — the compose name after
a consumer's `as` rename, which is the name the session network resolves
(`compose-generator.ts`, the `shipit-session` network; ShipIt sets no extra
aliases).

Validation follows each file's existing style:

- **Manifest** (`parseExportEntry`): an invalid `mcp` drops the whole export,
  like every other manifest field. Invalid means: not a mapping, no `service`,
  a `path` that is not an absolute URL path of plain characters, no `compose`
  key to find the service in, or a plugin name that cannot name an MCP server
  (below).
- **Project** (`parseShipitConfig`): an invalid entry is a `shipit.yaml` warning
  and is skipped; the rest of the file still applies.

## Names (req 9)

A server name is letters, digits, `_` and `-`. A dot is refused because Codex
writes the name into a TOML table key (`[mcp_servers.<name>]`), and the agent's
tool names are `mcp__<name>__<tool>`. `shipit` and `playwright` are taken by the
servers ShipIt always gives the agent.

A name stays the declared name or the server is not given — it is never
renamed, because the plugin's web UI writes it into a message. So a collision
withholds a server, and says why:

- **A project server and a plugin server** with one name: the project's wins, as
  the project's own service name wins over a plugin's (docs/262). The Plugins
  card reports the plugin's.
- **Two plugin servers** with one name (one plugin imported under two aliases,
  or two repositories that export one plugin name): the first `plugins.use`
  entry wins; the card reports the later one.
- **An account server** (`mcp.servers`) with the name of a declared server: the
  declared server wins in that session, and the account server is not given to
  that session's agent. The declared one is the project's own choice, and the
  plugin's web UI depends on its name.

## The proxy

`src/server/session/mcp-service-proxy.ts`, bundled by
`scripts/build-mcp-bridges.mjs` beside the `shipit` bridge (docs/199) and
launched as `node mcp-service-proxy.js <url>`. The URL is an argument, not an
environment variable: Codex sets an MCP child's environment for the whole
process, so two servers would share one variable.

- **`initialize`** is answered at once, with `tools: { listChanged: true }`.
  Nothing waits for the service, so an agent's MCP start-up deadline never
  depends on it.
- **The first `tools/list`** waits for the first connection attempt, at most
  3 s. A backend that starts a process per turn reads the tools once, at that
  list, so when the service is already up the tools must be in it.
- **Not reachable:** the proxy tries again after 1 s, doubling to at most 15 s.
  When the service answers, the proxy reads its tools and sends
  `tools/list_changed` if they differ from the last list it gave (req 6, 7).
- **Reachable:** the proxy reads the list again every 60 s and sends
  `tools/list_changed` when it changed — a plugin refresh can restart the
  service with other tools (req 8).
- **`tools/call`** goes to the service with the agent's arguments, and its result
  comes back unchanged. A call the service cannot be reached for returns a tool
  error that names the service, the URL and `shipit service list`, and puts the
  proxy back on the fast retry. It is not retried: the service can have done the
  work before the connection broke. (A stateful server that restarted answers
  the old session with an error; the retry opens a new session, and the agent's
  next call works.)
- **While the service is down** the last tool list stays. Calls fail with the
  message above; when the service is back they work again.
- **Only tools.** The server's `instructions`, resources and prompts are not
  forwarded: `instructions` are read once at `initialize`, which the proxy
  answers before the service is up, so they would reach the agent only
  sometimes. A plugin gives the agent its guidance in a skill.

## When the tools arrive (req 7)

| Backend | Process | Tools arrive |
|---|---|---|
| Claude, live steering on (the default) | resident across turns | as soon as the service answers, also in the middle of a turn |
| Claude with steering off, Codex, Grok, OpenCode, Antigravity | one per turn | at the start of the first turn that begins while the service answers |

The resident Claude reloads its tools on `tools/list_changed`: verified in the
pinned CLI (2.1.284), whose MCP client registers the handler when the server's
`capabilities.tools.listChanged` is true ("Received tools/list_changed
notification, refreshing tools"). The per-turn backends start a new proxy each
turn, and its first `tools/list` waits for the service as described above.

**The declared set can change under a resident process.** The proxy covers the
service; it cannot cover a server whose declaration the process never received.
That happens on every new session whose first turn spawns before the plugin's
version is live, and on an edit to `shipit.yaml` that adds a server. So the set
a resident was spawned with is recorded (`recordServiceMcpSpawn` in
`orchestrator/service-mcp.ts`, called from `buildAgentRunParams`, the same place
as the status-card record of docs/303),
and the next turn retires a resident whose set differs
(`releaseResidentOnServiceMcpChange`). The next process resumes the
conversation, as for a model change. The user restarts nothing. A set ShipIt
cannot read (an invalid `shipit.yaml` in the middle of an edit) retires
nothing.

## Reporting

- A plugin server that is not given — its service has no port, the manifest
  names a service the fragment does not define, or its name is taken — is a row
  on the repository's card in the Plugins tab and a line in `shipit plugin
  status`. These rows do not withhold the plugin's services: the import is valid,
  only its MCP server is missing. (`collectPluginFragments` returns them apart
  from `issuesByRepo`, which withholds the repository's whole stack.)
- A project entry that is invalid is a `shipit.yaml` warning, like any other.
- A service that is declared but not running shows as a server with no tools.
  `shipit service list` says why the service is not running.

## Rejected alternatives

- **An HTTP entry in the agent's MCP config, pointing at the service.** The
  agent connects once, at start. In print mode the Claude CLI marks a server it
  cannot reach `failed` and does not try again (its initial-connect retry is in
  the interactive UI only), so a service that starts after the agent — the
  normal case for a new session — would need an agent restart.
- **Retiring the agent when the service starts or restarts.** It is the restart
  that req 7 and req 8 rule out, it cannot happen in the middle of a turn, and it
  would happen again on every crash loop of the service.
- **The orchestrator pushing service status to the proxy.** The orchestrator
  knows when a service runs (`ServiceManager`, the `service_status` event), but a
  push needs a new worker endpoint and a channel from the worker to every proxy.
  Polling stays inside the proxy, costs one connection attempt at most every
  15 s while the service is down, and also sees a service that answers later
  than its container starts.
- **Counting declared servers as account servers.** Req 4 and req 5 rule it out:
  an account server reaches every session of the account.

## Key files

- `src/server/shared/service-mcp.ts` — the declaration form shared by the
  manifest and the project: name and path rules, the default path, the URL.
- `src/server/shared/plugin-repos.ts` — `PluginExport.mcp`, parsed in
  `parseExportEntry`.
- `src/server/shared/shipit-config.ts` — `ShipitConfig.mcp`, the project's
  servers.
- `src/server/orchestrator/plugin-compose.ts` — `collectPluginFragments` resolves
  each plugin server to its service and port, and returns `mcpIssuesByRepo`.
- `src/server/orchestrator/service-manager.ts` — `pluginMcpServers()`, from the
  resolved plugin services.
- `src/server/orchestrator/service-mcp.ts` — `resolveServiceMcpServers` (the
  project's and the plugins' servers for one session, which
  `ContainerSessionRunner.serviceMcpServers()` returns), and the spawn record.
- `src/server/orchestrator/resident-spawn-guard.ts` —
  `releaseResidentOnServiceMcpChange`, called on the interactive path
  (`ws-handlers/agent-execution.ts`) and the dispatched path
  (`dispatched-turn.ts`).
- `src/server/orchestrator/api-routes-plugin-repos.ts` — adds the MCP rows to
  the card's service issues.
- `src/server/orchestrator/session-agent-run-params.ts` — sets
  `serviceMcpServers`, and leaves out an account server with a declared name.
- `src/server/session/mcp-config-controller.ts` — `withServiceMcpServers`, the
  stdio entries.
- `src/server/session/mcp-service-proxy.ts` — the proxy.
