import { mcpUrlProjection } from "./projection.js";
import {
  configuredOnly,
  defineSetting,
  derived,
  itemAddress,
  plain,
  userText,
} from "./types.js";
import type { AnySettingDeclaration } from "./types.js";
import { bool, collection, enumOf, secretBag, text } from "./value-types.js";

/**
 * The **Integrations** tab (docs/299-agent-settings-access, plan.md → Scope
 * inventory). Auto-create-PR is a single stored value and is declared with the
 * global scalars; everything here belongs to a panel of its own.
 *
 * **The MCP entries are why a projection is an allowlist.** One entry takes
 * arbitrary `args`, `env`, `headers` and a URL (`services/mcp.ts:49`, `:63`), so
 * a token lives in a field called `args` and a field-name deny-list cannot
 * work. What a server emits is its name, its transport, whether it is enabled
 * and its URL's host — each from the declaration that owns that field, and
 * nothing from the fields that carry credentials.
 *
 * A field with no declaration has nothing to bind to: that is the point of
 * declaring `mcp.servers[].command` rather than `mcp.servers`.
 */

const MCP_ADDRESS = itemAddress("an MCP server name");

export const INTEGRATIONS_SETTINGS = {
  "mcp.servers": defineSetting({
    key: "mcp.servers",
    tab: "integrations",
    scope: "global",
    label: "MCP servers",
    description:
      "Tools the agent gets through the Model Context Protocol. They run with the credentials you "
      + "provide. At most ten may be enabled at once.",
    type: collection<string>({
      operations: ["add", "remove", "enable", "disable"],
      patchableFields: ["enabled"],
    }),
    store: { kind: "bespoke", ownedBy: "credential-store MCP servers (/api/mcp-servers)" },
    emits: derived("the server names", (raw) =>
      Array.isArray(raw)
        ? raw
            .map((server) => (typeof server === "string" ? server : (server as { name?: unknown })?.name))
            .filter((name): name is string => typeof name === "string")
        : []),
    propose: { kind: "yes" },
  }),

  "mcp.servers[].name": defineSetting({
    key: "mcp.servers[].name",
    tab: "integrations",
    scope: "global",
    address: MCP_ADDRESS,
    label: "Name",
    description:
      "What this server is called. It becomes part of the tool names the agent sees, so it is "
      + "lowercase alphanumeric starting with a letter, and no two servers share one.",
    type: text({ maxLength: 64, noun: "MCP server name", required: true, trim: true }),
    store: { kind: "bespoke", ownedBy: "credential-store MCP servers (/api/mcp-servers)" },
    emits: userText(
      "The server's name is how the panel and the agent both address it. ShipIt validates it to "
      + "lowercase alphanumerics, so it cannot carry a token.",
    ),
    // Renaming rewrites the server's secret keys (`mcp__<name>__KEY`), which the
    // card cannot show, so the rename is not offered even though the name is read.
    propose: { kind: "no", reason: "unsafe_to_display" },
  }),

  "mcp.servers[].type": defineSetting({
    key: "mcp.servers[].type",
    tab: "integrations",
    scope: "global",
    address: MCP_ADDRESS,
    label: "Transport",
    description:
      "How ShipIt reaches this server: a local command over stdio, or an HTTP endpoint.",
    type: enumOf({
      default: "stdio",
      options: [
        { value: "stdio", label: "Command (stdio)" },
        { value: "http", label: "HTTP" },
      ],
    }),
    store: { kind: "bespoke", ownedBy: "credential-store MCP servers (/api/mcp-servers)" },
    emits: plain(),
    // Switching transport replaces the whole configuration — command, arguments
    // and environment for a URL and headers — so a card cannot show its effect.
    propose: { kind: "no", reason: "unsafe_to_display" },
  }),

  "mcp.servers[].enabled": defineSetting({
    key: "mcp.servers[].enabled",
    tab: "integrations",
    scope: "global",
    address: MCP_ADDRESS,
    label: "Enabled",
    description:
      "Whether this server's tools are given to the agent. Disabling leaves the configuration in "
      + "place.",
    type: bool({ default: true }),
    store: { kind: "bespoke", ownedBy: "credential-store MCP servers (/api/mcp-servers)" },
    emits: plain(),
    // One boolean the card shows in full — plan.md's worked pair, the allowed half.
    propose: { kind: "yes" },
  }),

  "mcp.servers[].command": defineSetting({
    key: "mcp.servers[].command",
    tab: "integrations",
    scope: "global",
    address: MCP_ADDRESS,
    label: "Command",
    description:
      "The executable a stdio server is started with. Shell metacharacters are refused, so it is "
      + "one program and not a shell line.",
    type: text({ maxLength: 500, noun: "MCP server command", required: true, trim: true }),
    store: { kind: "bespoke", ownedBy: "credential-store MCP servers (/api/mcp-servers)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "unsafe_to_display" },
  }),

  "mcp.servers[].args": defineSetting({
    key: "mcp.servers[].args",
    tab: "integrations",
    scope: "global",
    address: MCP_ADDRESS,
    label: "Arguments",
    description:
      "The arguments the command is started with. A provider's token is routinely passed here, so "
      + "ShipIt reports only whether any are set.",
    type: secretBag({ shape: "list", noun: "MCP server arguments" }),
    store: { kind: "bespoke", ownedBy: "credential-store MCP servers (/api/mcp-servers)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),

  "mcp.servers[].npmPackage": defineSetting({
    key: "mcp.servers[].npmPackage",
    tab: "integrations",
    scope: "global",
    address: MCP_ADDRESS,
    label: "npm package",
    description: "Installed at session start, for a stdio server that needs it.",
    type: text({ maxLength: 200, noun: "npm package", trim: true }),
    store: { kind: "bespoke", ownedBy: "credential-store MCP servers (/api/mcp-servers)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "unsafe_to_display" },
  }),

  "mcp.servers[].url": defineSetting({
    key: "mcp.servers[].url",
    tab: "integrations",
    scope: "global",
    address: MCP_ADDRESS,
    label: "URL",
    description:
      "Where an HTTP server is reached. ShipIt reports its scheme and host; a path, a query and "
      + "any user information in it are where a token travels, so none of them is emitted.",
    type: text({ maxLength: 2_000, noun: "MCP server url", required: true, trim: true }),
    store: { kind: "bespoke", ownedBy: "credential-store MCP servers (/api/mcp-servers)" },
    emits: derived("the URL's scheme and host, with user information, path and query dropped", mcpUrlProjection),
    // plan.md's worked pair, the refused half: the card would either show less
    // than it changes or echo a path the agent may not read back.
    propose: { kind: "no", reason: "unsafe_to_display" },
  }),

  "mcp.servers[].env": defineSetting({
    key: "mcp.servers[].env",
    tab: "integrations",
    scope: "global",
    address: MCP_ADDRESS,
    label: "Environment variables",
    description:
      "Given to a stdio server when it starts. Stored as secrets and resolved inside the session "
      + "container, so ShipIt reports only whether any are set.",
    type: secretBag({ shape: "map", noun: "MCP server environment variables" }),
    store: { kind: "bespoke", ownedBy: "MCP secrets, stored apart from the server config (`secrets` on /api/mcp-servers)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),

  "mcp.servers[].headers": defineSetting({
    key: "mcp.servers[].headers",
    tab: "integrations",
    scope: "global",
    address: MCP_ADDRESS,
    label: "Headers",
    description:
      "Sent with every request to an HTTP server. Stored as secrets — a bearer token is the usual "
      + "content — so ShipIt reports only whether any are set.",
    type: secretBag({ shape: "map", noun: "MCP server headers" }),
    store: { kind: "bespoke", ownedBy: "MCP secrets, stored apart from the server config (`secrets` on /api/mcp-servers)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),

  "mcp.oauthProvider": defineSetting({
    key: "mcp.oauthProvider",
    tab: "integrations",
    scope: "global",
    address: itemAddress("an MCP OAuth provider id"),
    label: "MCP provider connection",
    description:
      "An MCP server ShipIt can connect for you through the provider's own OAuth flow. ShipIt "
      + "reports whether it is connected, never its tokens.",
    type: text({ maxLength: 200, noun: "MCP provider connection" }),
    store: { kind: "bespoke", ownedBy: "MCP OAuth tokens (/api/mcp-servers/oauth/:source)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "external_flow" },
  }),

  "integrations.github.connection": defineSetting({
    key: "integrations.github.connection",
    tab: "integrations",
    scope: "global",
    label: "GitHub",
    description:
      "The GitHub account ShipIt pushes, opens pull requests and reads checks as. It is a token "
      + "the user creates on GitHub and pastes in, so ShipIt reports the account and whether it is "
      + "connected, never the token.",
    type: text({ maxLength: 500, noun: "GitHub token" }),
    store: { kind: "bespoke", ownedBy: "the GitHub credential (POST /api/github/token)" },
    emits: configuredOnly(),
    // A pasted classic token, not a sign-in ShipIt can send the user through:
    // `GitHubTokenForm` takes the token itself, so this is `secret`.
    propose: { kind: "no", reason: "secret" },
  }),

  "integrations.linear.credential": defineSetting({
    key: "integrations.linear.credential",
    tab: "integrations",
    scope: "global",
    label: "Linear",
    description:
      "An API token for Linear, so issues render inline and `shipit issue` can reach them. Which "
      + "team a repository's Issues tab shows is that repository's own declaration, not a setting "
      + "here.",
    type: text({ maxLength: 500, noun: "Linear API token" }),
    store: { kind: "bespoke", ownedBy: "the Linear credential (POST /api/trackers/linear/token)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),
} as const satisfies Record<string, AnySettingDeclaration>;
