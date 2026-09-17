import {
  mcpUrlProjection,
  sshAddressProjection,
  sshUserProjection,
  userNamesProjection,
} from "./projection.js";
import {
  configuredOnly,
  defineSetting,
  derived,
  itemAddress,
  plain,
  userName,
} from "./types.js";
import type { AnySettingDeclaration } from "./types.js";
import type { McpHttpServerConfig, McpStdioServerConfig } from "../types/mcp-types.js";
import type { SshHostPublic } from "../types/domain-types/ssh.js";
import { bool, collection, enumOf, numeric, secretBag, text } from "./value-types.js";

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
 *
 * **Declaration order is the tab's order** (docs/308-data-driven-settings
 * req 11), so the tiering docs/201 gave this tab is expressed here rather than
 * in `SettingsIntegrations.tsx`: credentials ShipIt brokers, then the
 * destinations it brokers keys for, then the servers the user brings their own
 * credentials to. The MCP block was first in this file and is last now, because
 * leaving it there would have rendered "runs with whatever credentials you
 * provide" above the brokered connections.
 */

const MCP_ADDRESS = itemAddress("an MCP server name");
const SSH_HOST_ADDRESS = itemAddress("an SSH destination name");

/** The tab's first section: the credentials ShipIt brokers on the user's behalf. */
const CONNECTED_SERVICES = "Connected services";

export const INTEGRATIONS_SETTINGS = {
  /**
   * The two pasted-token connections are **generated credential rows**
   * (docs/308-data-driven-settings inventory.md P2, P10): each names a
   * component and carries the address that stores it, so the dialog builds
   * neither the request nor the payload field.
   *
   * `writeOnly`, because the path takes a token and answers no GET — which is
   * also why neither enters the browser's value record. What the card shows
   * instead is the CONNECTION: the account for GitHub, the reachable teams for
   * Linear, both derived from the credential rather than being it.
   */
  "integrations.github.connection": defineSetting({
    key: "integrations.github.connection",
    tab: "integrations",
    section: CONNECTED_SERVICES,
    component: "github-connection",
    scope: "global",
    label: "GitHub",
    description:
      "The GitHub account ShipIt pushes, opens pull requests and reads checks as. It is a token "
      + "the user creates on GitHub and pastes in, so ShipIt reports the account and whether it is "
      + "connected, never the token.",
    type: text({ maxLength: 500, noun: "GitHub token" }),
    store: {
      kind: "own-route", method: "POST", path: "/api/github/token",
      bodyField: "token", writeOnly: true,
    },
    emits: configuredOnly(),
    // A pasted classic token, not a sign-in ShipIt can send the user through:
    // `GitHubTokenForm` takes the token itself, so this is `secret`.
    propose: { kind: "no", reason: "secret" },
  }),

  "integrations.linear.credential": defineSetting({
    key: "integrations.linear.credential",
    tab: "integrations",
    section: CONNECTED_SERVICES,
    component: "linear-credential",
    scope: "global",
    label: "Linear",
    description:
      "An API token for Linear, so issues render inline and the shipit issue command can reach "
      + "them. Which team a repository's Issues tab shows is that repository's own declaration, "
      + "not a setting here.",
    type: text({ maxLength: 500, noun: "Linear API token" }),
    store: {
      kind: "own-route", method: "POST", path: "/api/trackers/linear/token",
      bodyField: "token", writeOnly: true,
    },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),

  /**
   * docs/305 — the SSH destination registry. The private half of each key never
   * leaves the orchestrator's credential store, so nothing here emits key
   * material: what a read gives is the destinations the user configured, and
   * `~/.ssh/config` is what tells a session which ones it may actually use.
   * Adding one is not proposable — it is only useful once the user has installed
   * its public line on the server, which ShipIt cannot do.
   *
   * **The destination form's four boxes are four settings.** They were an
   * `action` exclusion — "nothing is stored until Add destination is pressed,
   * and the collection is what carries the policy" — which was false of three of
   * them: the collection carries labels only, while the address, the user and
   * the port are persisted (`api-routes-ssh.ts`) and shown back on the row. The
   * same four boxes now edit a destination in place (docs/305 req 14), so each
   * one has TWO writes behind it, and `HostFields` renders them once for both.
   *
   * **Each refusal below is about the edit, since that is the write a card could
   * otherwise carry.** They are not one reason repeated: `address` and `user`
   * decide which account on which machine must hold the public line, which is
   * the user's act somewhere ShipIt cannot reach; `port` and `label` need no act
   * outside ShipIt and are refused because a card cannot show what the change
   * actually does.
   *
   * **A read answers with the destinations THIS session is granted, and the
   * registry is not readable from a session at all.** `api-container-guard.ts`
   * hard-denies `/api/ssh-hosts` to every container — "a container has no
   * business … reading the list" — so the reader is scoped to the grant
   * (`settings-store-readers.ts` → `sessionSshHosts`) rather than enumerating
   * what the guard shuts. For a granted destination this emits nothing new:
   * ShipIt already writes its address, user and port into the session's own
   * `~/.ssh/config`.
   */
  "integrations.sshHosts": defineSetting({
    key: "integrations.sshHosts",
    tab: "integrations",
    component: "ssh-hosts",
    scope: "global",
    label: "SSH hosts",
    description:
      "Remote servers a session can reach over SSH. ShipIt generates a key for each destination "
      + "and signs with it; the private half never enters a session container. A destination is "
      + "granted to a session in that session's own settings, and until it is granted the session "
      + "can neither reach it nor authenticate to it. A read answers with the destinations THIS "
      + "session is granted — an empty answer means this session has none, not that none is "
      + "registered, and the rest of the registry is not readable from a session.",
    type: collection<string>({ operations: ["add", "remove"], patchableFields: [] }),
    store: { kind: "bespoke", ownedBy: "credential-store SSH hosts (/api/ssh-hosts)" },
    // The same shape gate the other name-addressed collections use. A
    // destination's label is free text — the route caps its length and rejects
    // control characters and nothing more — so a pasted URL, which carries a
    // credential in its userinfo and its query as a matter of routine, is a
    // possible stored value here in a way an MCP server name is not.
    emits: derived(
      "the destinations' names",
      (raw) =>
        userNamesProjection(
          Array.isArray(raw)
            ? raw.map((host) => ({ name: (host as { label?: unknown })?.label }))
            : raw,
        ),
      {
        userText: "The labels are the user's own, and how the panel and the agent both address a "
          + "destination. The shape gate is what keeps a pasted URL out; it does not make the "
          + "label ShipIt's own text.",
      },
    ),
    // A destination is inert until its public line is installed on the server,
    // which is the user's act on a machine ShipIt does not reach.
    propose: { kind: "no", reason: "external_flow" },
  }),

  "integrations.sshHosts[].label": defineSetting({
    key: "integrations.sshHosts[].label",
    tab: "integrations",
    scope: "global",
    address: SSH_HOST_ADDRESS,
    label: "Name",
    description:
      "What this destination is called here, and the name a settings read addresses it by. The "
      + "alias a granted session types after ssh is DERIVED from this — lowercased, punctuation "
      + "replaced, and numbered when two labels collide — so the two can differ; `~/.ssh/config` "
      + "is what says which alias a session actually has.",
    type: text({ maxLength: 200, noun: "SSH destination name", required: true, trim: true }),
    store: { kind: "bespoke", ownedBy: "credential-store SSH hosts (/api/ssh-hosts)" },
    emits: userName(
      "The destination's name is how the panel and the agent both address it. The route caps its "
      + "length and rejects control characters and nothing more, so the shape gate is what keeps a "
      + "pasted URL from being repeated back.",
    ),
    // Renaming needs no act outside ShipIt, so `external_flow` would be untrue —
    // but the alias every granted session types is DERIVED from this name, and
    // numbered when it collides with another, so a card reading
    // `prod → Prod Server` cannot show that `ssh prod` becomes `ssh prod-server`
    // — or `prod-server-2`. The same reason `mcp.servers[].name` is refused, and
    // `alsoChanges` is not the answer to it: that names a stored value changing
    // beside the one asked for, while an alias is computed per granted session
    // in `ssh-provision.ts` and is a different string in each of them.
    propose: { kind: "no", reason: "unsafe_to_display" },
  }),

  "integrations.sshHosts[].address": defineSetting({
    key: "integrations.sshHosts[].address",
    tab: "integrations",
    scope: "global",
    address: SSH_HOST_ADDRESS,
    label: "Address",
    description:
      "Where this destination is, as a hostname or an IP address. A granted session reaches it "
      + "through this address and no other; an IP destination is reached with no DNS lookup at all.",
    type: text({ maxLength: 253, noun: "SSH destination address", required: true, trim: true }),
    store: { kind: "bespoke", ownedBy: "credential-store SSH hosts (/api/ssh-hosts)" },
    emits: derived(
      "the address, when it is shaped like a hostname or an IP literal",
      sshAddressProjection,
      {
        userText: "The address is the user's own, and it is the operational fact the agent needs "
          + "to explain why a destination is unreachable. It is not credential material: SSH "
          + "authenticates with a key ShipIt holds, and reaching the address proves nothing.",
      },
    ),
    // Either write — the `add` or the in-place edit — points the destination at
    // a machine, and it is inert there until the user installs its public line
    // on that machine. ShipIt cannot reach it to do so.
    //
    // `requireAddress` also LOWERCASES what it stores, which no value-type option
    // describes — the way `trim` describes the trim (req 9). It costs nothing
    // while this refuses, since no card can show a change Apply would alter; a
    // later change making it proposable has to answer it first.
    propose: { kind: "no", reason: "external_flow" },
  }),

  "integrations.sshHosts[].user": defineSetting({
    key: "integrations.sshHosts[].user",
    tab: "integrations",
    scope: "global",
    address: SSH_HOST_ADDRESS,
    label: "User",
    description:
      "The account on the remote server that ShipIt logs in as. The public line has to be "
      + "installed in that account's authorized_keys, and the signer refuses a request naming "
      + "any other user.",
    type: text({ maxLength: 64, noun: "SSH destination user", required: true, trim: true }),
    store: { kind: "bespoke", ownedBy: "credential-store SSH hosts (/api/ssh-hosts)" },
    emits: derived("the user name, when it is shaped like one", sshUserProjection, {
      userText: "The account name is text the operator typed, and it is half of what the user "
        + "checks when a destination refuses the key — the other half is which account carries "
        + "the public line.",
    }),
    // This names the account whose `authorized_keys` must hold the public line,
    // so changing it is only finished by the user installing that line in the
    // new account — on the server, where ShipIt cannot go.
    propose: { kind: "no", reason: "external_flow" },
  }),

  "integrations.sshHosts[].port": defineSetting({
    key: "integrations.sshHosts[].port",
    tab: "integrations",
    scope: "global",
    address: SSH_HOST_ADDRESS,
    label: "Port",
    description: "The TCP port sshd listens on at this destination. 22 unless it was changed.",
    type: numeric({ default: 22, min: 1, max: 65_535, integer: true }),
    store: { kind: "bespoke", ownedBy: "credential-store SSH hosts (/api/ssh-hosts)" },
    // A number in a fixed range, gated by the route and by this value type. It
    // is neither the user's prose nor anything ShipIt derived, so it is plain.
    emits: plain(),
    // The one field here that needs nothing outside ShipIt — sshd is listening
    // on the new port or it is not — so `external_flow` would be untrue of it.
    // What a card cannot show is the rest of the write: saving a port change
    // DISCARDS the recorded server host key (`credential-store.ts`
    // → `updateSshHost`), so the next connection verifies the server again and
    // can be refused when the orchestrator cannot observe that key there
    // (docs/305-ssh-hosts req 13). `2222 → 22` shows none of that, which is why
    // req 14 makes the DIALOG say it before the change is saved — a warning
    // beside the boxes that a proposal card has no equivalent of.
    //
    // `alsoChanges` could name the key being forgotten, since that IS a stored
    // value moving. It cannot name the part that matters: whether the next
    // connection succeeds is decided later, by a scan of the new endpoint that
    // no card can run at the moment the user clicks.
    propose: { kind: "no", reason: "unsafe_to_display" },
  }),

  "mcp.servers": defineSetting({
    key: "mcp.servers",
    tab: "integrations",
    component: "mcp-servers",
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
    // The same shape gate the other name-addressed collections use. It refuses
    // nothing `validateMcpServerConfig` would have stored — a server name is
    // already lowercase alphanumeric — so this is the rule being uniform rather
    // than a second validator.
    emits: derived(
      "the server names; a name not shaped like one is dropped",
      userNamesProjection,
      { userText: "The names are the user's own, and how the panel and the agent both address a server." },
    ),
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
    emits: userName(
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
      // The dialog renders these, so each one says what it is rather than
      // naming a transport the user has no reason to know.
      options: [
        { value: "stdio", label: "stdio — a command ShipIt spawns" },
        { value: "http", label: "http — a remote endpoint" },
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
      "The arguments the command is started with, space-separated. A provider's token is routinely "
      + "passed here, so ShipIt reports only whether any are set.",
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
    description: "Optional. Installed at session start, for a stdio server that needs it.",
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
    emits: derived(
      "the URL's scheme and host, with user information, path and query dropped",
      mcpUrlProjection,
      { shipItComputed: "ShipIt parses the URL and emits two fields of its own; the string the user typed is not repeated back." },
    ),
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

  /**
   * Addressed by a provider and belonging to no collection of its own, so it
   * names the panel that repeats it — `voice.providerKey`'s shape (P11). An
   * item field whose collection already names the component does not repeat it.
   */
  "mcp.oauthProvider": defineSetting({
    key: "mcp.oauthProvider",
    tab: "integrations",
    component: "mcp-servers",
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

} as const satisfies Record<string, AnySettingDeclaration>;

/**
 * Why a stored field is not a declared setting. The same judgement
 * `exclusions.ts` makes about a dialog control, made about a persisted field —
 * and, like that one, a claim in prose that review reads.
 */
interface NotASetting { readonly notASetting: string }

/**
 * The one declaration a stored field may name: its own.
 *
 * Naming *any* declaration would leave the loophole open — a new field mapped to
 * `mcp.servers[].command` would compile, which is the same "bound to something
 * that exists" pass the DOM walk gives. The key has to be derived from the field
 * name, so the only way to account for a new field is to declare it under that
 * name or to explain why it is not a setting.
 */
type DeclarationForField<C extends string, F extends string> =
  `${C}[].${F}` extends keyof typeof INTEGRATIONS_SETTINGS ? `${C}[].${F}` : never;

/**
 * **Every field of a stored MCP server, mapped to the declaration that
 * describes it** (req 7: no way to ship a setting the agent cannot see).
 *
 * It runs over the STORED shape rather than over the dialog, which is what
 * makes it a compile error rather than a test: keyed by `keyof McpServerConfig`,
 * a field added to `mcp-types.ts` fails here until it is either declared or
 * explained, whatever the dialog renders.
 *
 * The gap was not hypothetical. `setup` — a pre-start command for non-npm stdio
 * servers, designed in `docs/088-mcp-integration/plan.md:405` — was accepted by
 * the stored type and by `validateMcpServerConfig` from that integration onwards
 * and read by nothing for as long. It is deleted rather than declared, because a
 * stored value with no effect is not a setting to report; if the feature is
 * wanted, docs/088 still holds the design and re-adding the field will fail here
 * until it is declared.
 */
export const MCP_SERVER_FIELD_SETTINGS: {
  [F in keyof McpStdioServerConfig | keyof McpHttpServerConfig]:
    DeclarationForField<"mcp.servers", F & string> | NotASetting;
} = {
  name: "mcp.servers[].name",
  type: "mcp.servers[].type",
  enabled: "mcp.servers[].enabled",
  command: "mcp.servers[].command",
  args: "mcp.servers[].args",
  env: "mcp.servers[].env",
  npmPackage: "mcp.servers[].npmPackage",
  url: "mcp.servers[].url",
  headers: "mcp.servers[].headers",
};

/**
 * The same map for a stored SSH destination, keyed by `keyof SshHostPublic` —
 * the shape every read path returns.
 *
 * It exists because these fields went undeclared for weeks: the
 * add-a-destination form is not rendered until somebody presses a button, so
 * nothing that reads the dialog could have found them. This map depends on
 * nothing being rendered — a field added to `SshHostPublic` is a compile error
 * here until it is declared or explained.
 *
 * Most of this destination is ShipIt's own: the id, the key material and the
 * fingerprints are generated or observed, and none is a value anyone sets.
 */
export const SSH_HOST_FIELD_SETTINGS: {
  [F in keyof SshHostPublic]-?:
    DeclarationForField<"integrations.sshHosts", F & string> | NotASetting;
} = {
  label: "integrations.sshHosts[].label",
  address: "integrations.sshHosts[].address",
  user: "integrations.sshHosts[].user",
  port: "integrations.sshHosts[].port",
  id: { notASetting: "ShipIt's own handle for the row; the user neither sets nor sees it." },
  publicKeyBlob: { notASetting: "Half of the key pair ShipIt generated (docs/305-ssh-hosts req 5). Nobody chooses it." },
  identityLine: { notASetting: "The same generated public key, in the form OpenSSH's identity loader takes." },
  authorizedKeysLine: { notASetting: "The same generated public key again, with restrictions — what the user installs on the server. Its dialog control only copies it (`integrations.sshHostPublicLine`)." },
  fingerprint: { notASetting: "Of ShipIt's own generated key; computed, not stored by anyone's choice." },
  hostKeyFingerprint: { notASetting: "Of the SERVER's key, as the orchestrator observed it at the address (req 13). An observation, and its one control forgets it (`integrations.sshHostKeyForget`)." },
  hostKeyType: { notASetting: "The algorithm of that same observed server key." },
  hostKeyRecordedAt: { notASetting: "When the observation above was recorded." },
  createdAt: { notASetting: "When the destination was added." },
};
