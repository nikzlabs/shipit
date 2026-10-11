---
issue: planning#686
title: MCP servers on a plugin's or a project's Compose service
description: A plugin or a project declares an MCP server that runs on one of its Compose services, and ShipIt gives it to the agent in that project's sessions only.
---

# 327 — MCP servers on a plugin's or a project's Compose service

The design that implements these requirements is in [`plan.md`](./plan.md).

The request came from the repository nikzlabs/verseshot (its design 019, change
"S1"). Verseshot gives an agent MCP tools in ChatGPT and in Claude, and gives a
ShipIt agent a `vs` plugin command and a skill instead. It wants the same MCP
tools in ShipIt, so that each tool is written one time and `vs` can go.

1. A plugin's manifest can name an MCP server that runs on one of the plugin's
   own Compose services.
2. A project can name, in its own `shipit.yaml`, an MCP server that runs on one
   of its own Compose services, in the same form as a plugin's. (Verseshot needs
   this for its `api` service, its development store, which has the same tools.)
3. The server is an HTTP MCP server (stateless Streamable HTTP), served on the
   service's port at a path that the declaration names.
4. The agent gets the server only in the sessions whose project uses the plugin,
   or declares the server. The other sessions of the same account do not get it.
5. A declared server does not use one of the account's MCP server slots
   (`mcp.servers`, of which at most 10 are on).
6. ShipIt connects to the server when the service starts, and again after a
   restart of the service.
7. The agent can start before the service is ready — the install of a new
   session can take minutes. The server's tools reach the agent when the service
   is ready, without a restart of the agent by the user. On a backend that
   starts a new agent process for each turn, "when the service is ready" can be
   the next turn.
8. After a restart of the service, the tools come back without a restart of the
   agent by the user, with the same allowance for a backend that starts a new
   agent process for each turn.
9. The server's name in the agent is predictable, so that a plugin's web UI can
   name it in a message to the agent: a plugin's server has the plugin's name
   (`verseshot`), and a project's server has the name that the project gives it
   in `shipit.yaml`.
10. The platform docs (`plugins.md`, `plugin-authoring.md`, `shipit-yaml.md`)
    tell a plugin author and an agent the new key, the server's name, and when
    the tools come.

## Not in scope

These are from the request, which named them as not needed:

- ShipIt does not become an MCP Apps host. The plugin's web UI stays in the
  Preview pane and uses `window.shipit` as today.
- No files go from the agent to the server.
- No login: the server is on the session's network, as the plugin's API is
  today.

## Open questions

*(none)*

## Resolved questions

- 2026-10-11 — Which key declares the server, and in which form? The request:
  "You choose the key and its form." The form is a design decision, recorded in
  [`plan.md`](./plan.md) → Declarations.
- 2026-10-11 — Is "at the next turn" enough for a backend that starts a new
  agent process for each turn (Codex, Grok, OpenCode, Antigravity, Claude with
  live steering off)? There a service that becomes ready in the middle of a turn
  gives its tools only at the next turn, unless that CLI reloads tools on
  `tools/list_changed`, which was not checked for those four; an independent
  review read requirement 7 as not fully met there. Nik: accept it as it is,
  because no backend needs a restart by the user and Verseshot's case is met.
  Recorded in requirements 7 and 8. The check of those four CLIs is not planned.
