import { allServices } from "../../shared/catalogue/index.js";
import { substituteMcpPlaceholders } from "../../shared/mcp-placeholders.js";
import { collectMcpAgentEnv } from "../secret-resolver.js";
import { buildEffectiveAllowlist } from "../egress-allowlist.js";
import { EGRESS_GLOBAL_SCOPE } from "../egress-allowlist-store.js";
import { keyRequiringProviders } from "../../shared/voice-catalog.js";
import type { CredentialBillingMode, CredentialRoute } from "../../shared/types.js";
import type { McpServerConfig } from "../../shared/types/mcp-types.js";
import type { ReviewerSlotView, RoleView } from "../../shared/types/agent-types.js";
import type { BespokeSettingKey } from "../../shared/settings-catalogue/index.js";
import { buildReviewerSettings } from "./reviewer-settings.js";
import { buildRoleSettings } from "./roles.js";
import { listCredentialRoutes } from "./credential-routes.js";
import { listMcpServers } from "./mcp.js";
import { listMcpOAuthProviders } from "./mcp-oauth.js";
import type { SettingsReadDeps } from "./settings-read-deps.js";

/**
 * Where a setting a panel of its own owns actually lives, read back
 * (docs/299-agent-settings-access req 3). A declaration whose store is
 * `bespoke` names the panel that writes the value, not how to read one — so
 * each owner has a reader here, and `settings-read.ts` is the only thing that
 * turns what they return into output.
 *
 * **A reader returns the STORED value and never a formatted one.** Every
 * emitted value leaves through `projectSetting` / `formatSetting` in
 * `settings-read.ts` (req 2); a reader that formatted its own value would be a
 * second door, and an MCP entry takes arbitrary `args`, `env`, `headers` and a
 * URL, so the second door is where a token leaves.
 *
 * **A reader never substitutes a default for a value it could not read.**
 * `unreadable` is the answer when the store this install would read is absent:
 * reporting a plausible default as the live value is worse than saying ShipIt
 * cannot see it, because the agent then states it to the user as fact.
 */

/** How one instance of an item-addressed setting is named. */
export type ItemName =
  /** A name ShipIt derived itself: a reviewer slot, a catalogue service or provider id. */
  | { readonly kind: "shipit"; readonly address: string }
  /**
   * The user's own name for it — a role, an MCP server, a secret, an allowlist
   * entry. The reader hands back the stored item rather than a string, and the
   * address is projected through the collection declaration that owns the key.
   * So the decision to emit that text was made once, in the declaration that
   * emits the same names as its value — and an entry the collection drops (a
   * URL pasted into the allowlist box) is named by nothing, so it has no item.
   */
  | { readonly kind: "stored"; readonly item: unknown; readonly prefix?: string };

export interface StoredItem {
  readonly name: ItemName;
  /** This declaration's field, for this instance. Stored, never projected. */
  readonly raw: unknown;
  /** ShipIt-derived sentences about this instance; never any of its value. */
  readonly notes?: string[];
}

export type StoredRead =
  | { readonly kind: "value"; readonly raw: unknown }
  | { readonly kind: "items"; readonly items: StoredItem[] }
  /** No value, and the note says why — never a default standing in for one. */
  | { readonly kind: "unreadable"; readonly note: string };

export interface StoreReadContext {
  readonly deps: SettingsReadDeps;
  readonly sessionId: string;
  /** The session's own repository binding; a project reader has no other source. */
  readonly repoUrl: string | null;
}

export type StoreReader = (ctx: StoreReadContext, cache: StoreReadCache) => StoredRead;

const NO_CREDENTIAL_STORE = "This install has no credential store, so ShipIt cannot read this value.";

/**
 * One pass over each owner's store per read. `list` asks 42 readers across
 * eight owners and several share a source — the role views alone resolve every
 * role against the catalogue and the configured credentials.
 */
export class StoreReadCache {
  private readonly memo = new Map<string, unknown>();

  constructor(private readonly ctx: StoreReadContext) {}

  private once<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as T;
  }

  private get deps(): SettingsReadDeps {
    return this.ctx.deps;
  }

  roles(): RoleView[] {
    return this.once("roles", () => {
      const credentialStore = this.deps.credentialStore;
      if (!credentialStore) return [];
      return buildRoleSettings({
        credentialStore,
        ...(this.deps.providerAccountManager
          ? { providerAccountManager: this.deps.providerAccountManager }
          : {}),
      });
    });
  }

  reviewerSlots(): ReviewerSlotView[] {
    return this.once("reviewers", () =>
      buildReviewerSettings({
        credentialStore: this.deps.credentialStore,
        ...(this.deps.providerAccountManager
          ? { providerAccountManager: this.deps.providerAccountManager }
          : {}),
      }),
    );
  }

  mcpServers(): McpServerConfig[] {
    return this.once("mcp", () => {
      const credentialStore = this.deps.credentialStore;
      return credentialStore ? listMcpServers(credentialStore) : [];
    });
  }

  /** Every credential route, in the order ShipIt tries them. */
  credentialRoutes(): CredentialRoute[] {
    return this.once("routes", () => {
      const credentialStore = this.deps.credentialStore;
      return credentialStore ? listCredentialRoutes(credentialStore) : [];
    });
  }

  /** The credential rows the Services panel lists; a provider account is not one. */
  stringRoutes(): CredentialRoute[] {
    return this.credentialRoutes().filter((route) => route.via !== "account");
  }

  /**
   * The (service, billing mode) pairs that have a credential at all. A pair
   * with none has nothing for a routing order or a failover cutoff to be about.
   */
  modePairs(): { serviceId: string; billingMode: CredentialBillingMode }[] {
    return this.once("modePairs", () => {
      const present = new Set(
        this.credentialRoutes().map((route) => `${route.serviceId}:${route.billingMode}`),
      );
      const out: { serviceId: string; billingMode: CredentialBillingMode }[] = [];
      for (const service of allServices()) {
        for (const mode of service.modes) {
          if (present.has(`${service.id}:${mode.kind}`)) {
            out.push({ serviceId: service.id, billingMode: mode.kind });
          }
        }
      }
      return out;
    });
  }

  providerAccounts(): CredentialRoute[] {
    return this.once("accounts", () => this.deps.providerAccountManager?.list() ?? []);
  }

  secretNames(): string[] {
    return this.once("secretNames", () => {
      const { repoUrl } = this.ctx;
      if (!repoUrl || !this.deps.secretStore) return [];
      return this.deps.secretStore.loadSecretNames(repoUrl);
    });
  }

  /**
   * Decrypted once per read, and only so `project.secrets[].value` can answer
   * whether a name has one. Nothing but `configured_only` is ever applied to
   * what this returns.
   */
  secretValues(): Record<string, string> {
    return this.once("secretValues", () => {
      const { repoUrl } = this.ctx;
      if (!repoUrl || !this.deps.secretStore) return {};
      return this.deps.secretStore.loadSecrets(repoUrl);
    });
  }

  /** The allowlist the Network tab shows: the shipped defaults plus the global additions. */
  globalAllowlist(): string[] {
    return this.once("allowlist", () => {
      const store = this.deps.egressAllowlistStore;
      if (!store) return [];
      return buildEffectiveAllowlist({
        ...(this.deps.credentialStore ? { credentialStore: this.deps.credentialStore } : {}),
        globalHosts: store.listHosts(EGRESS_GLOBAL_SCOPE),
        suppressedDefaults: store.listSuppressedDefaults(),
      }).map((entry) => entry.host);
    });
  }
}

function value(raw: unknown): StoredRead {
  return { kind: "value", raw };
}

function items(list: StoredItem[]): StoredRead {
  return { kind: "items", items: list };
}

function unreadable(note: string): StoredRead {
  return { kind: "unreadable", note };
}

function needsCredentialStore(ctx: StoreReadContext): StoredRead | null {
  return ctx.deps.credentialStore ? null : unreadable(NO_CREDENTIAL_STORE);
}

// Roles ---------------------------------------------------------------------

function roleNote(role: RoleView): string[] {
  if (role.params.kind === "auto") {
    return [
      "ShipIt resolves this role per review from the two reviewer candidate slots, so the role "
        + "itself pins nothing.",
    ];
  }
  switch (role.unavailableReason) {
    case "stranded":
      return [
        `This role names something this install does not have${role.invalidField ? ` (its ${role.invalidField})` : ""}`
          + ", so it cannot run until it is edited.",
      ];
    case "disconnected":
      return ["The credential this role runs on is not connected, so the role cannot run today."];
    case "quota_exhausted":
      return ["Every credential this role could run on is out of quota."];
    default:
      return [];
  }
}

function roleItems(
  ctx: StoreReadContext,
  cache: StoreReadCache,
  field: (role: RoleView) => unknown,
): StoredRead {
  const missing = needsCredentialStore(ctx);
  if (missing) return missing;
  return items(
    cache.roles().map((role) => {
      const notes = roleNote(role);
      return {
        // Named through the `roles` declaration, which emits these same names.
        name: { kind: "stored" as const, item: role },
        raw: field(role),
        ...(notes.length > 0 ? { notes } : {}),
      };
    }),
  );
}

/** A pinned role's model tuple; the reserved reviewer pins none. */
function rolePinnedSelection(role: RoleView): unknown {
  if (role.params.kind !== "pinned") return null;
  const { serviceId, billingMode, modelId } = role.params;
  return { serviceId, billingMode, modelId };
}

// Reviewer slots ------------------------------------------------------------

function reviewerNote(slot: ReviewerSlotView): string[] {
  switch (slot.unavailableReason) {
    case "pin_unavailable":
      // No fallback: `resolveSlotPlan` returns no target for a pinned slot it
      // cannot run (`reviewer-model.ts:311`), so the slot supplies nothing.
      return [
        "This slot's pinned model cannot run with the credentials configured, so the slot supplies "
          + "no reviewer at all until the pin is changed, cleared, or made runnable.",
      ];
    case "nothing_eligible":
      return ["No configured credential can run a reviewer, so this slot resolves to nothing."];
    default:
      return [];
  }
}

function reviewerItems(
  ctx: StoreReadContext,
  cache: StoreReadCache,
  field: (slot: ReviewerSlotView) => unknown,
): StoredRead {
  // Without a store there are no pins to read, and `buildReviewerSettings`
  // answers with two automatic slots — a plausible value nobody stored.
  const missing = needsCredentialStore(ctx);
  if (missing) return missing;
  return items(
    cache.reviewerSlots().map((slot) => {
      const notes = reviewerNote(slot);
      return {
        // "first" / "second" are ShipIt's own names for the two slots.
        name: { kind: "shipit" as const, address: slot.slot },
        raw: field(slot),
        ...(notes.length > 0 ? { notes } : {}),
      };
    }),
  );
}

// Credential routing --------------------------------------------------------

function modeItems(
  ctx: StoreReadContext,
  cache: StoreReadCache,
  field: (pair: { serviceId: string; billingMode: CredentialBillingMode }) => unknown,
): StoredRead {
  const missing = needsCredentialStore(ctx);
  if (missing) return missing;
  return items(
    cache.modePairs().map((pair) => ({
      // The catalogue's own ids, in the form the panel keys these settings by.
      name: { kind: "shipit" as const, address: `${pair.serviceId}:${pair.billingMode}` },
      raw: field(pair),
    })),
  );
}

function routeStatusNote(route: CredentialRoute): string[] {
  return route.status === "ready" ? [] : [`ShipIt records this credential as "${route.status}".`];
}

function routeItems(
  ctx: StoreReadContext,
  cache: StoreReadCache,
  field: (route: CredentialRoute) => unknown,
): StoredRead {
  const missing = needsCredentialStore(ctx);
  if (missing) return missing;
  return items(
    cache.stringRoutes().map((route) => {
      const notes = routeStatusNote(route);
      return {
        // Named through `services.credentials`, which emits these same ids.
        name: { kind: "stored" as const, item: route },
        raw: field(route),
        ...(notes.length > 0 ? { notes } : {}),
      };
    }),
  );
}

function accountItems(
  ctx: StoreReadContext,
  cache: StoreReadCache,
  field: (route: CredentialRoute) => unknown,
): StoredRead {
  if (!ctx.deps.providerAccountManager) {
    return unreadable("This install has no provider accounts, so ShipIt cannot read this value.");
  }
  return items(
    cache.providerAccounts().map((account) => {
      const notes = routeStatusNote(account);
      return {
        // A provider and an account id: the service is the catalogue's, the id
        // comes through `services.providerAccounts`, which emits these same ids.
        name: { kind: "stored" as const, item: account, prefix: account.serviceId },
        raw: field(account),
        ...(notes.length > 0 ? { notes } : {}),
      };
    }),
  );
}

// MCP -----------------------------------------------------------------------

function mcpItems(
  ctx: StoreReadContext,
  cache: StoreReadCache,
  field: (server: McpServerConfig) => unknown,
): StoredRead {
  const missing = needsCredentialStore(ctx);
  if (missing) return missing;
  return items(
    cache.mcpServers().map((server) => ({
      // Named through `mcp.servers`, which emits these same names.
      name: { kind: "stored" as const, item: server },
      raw: field(server),
    })),
  );
}

function stdioField(
  server: McpServerConfig,
  field: "command" | "args" | "npmPackage",
): unknown {
  return server.type === "stdio" ? server[field] ?? null : null;
}

/**
 * An environment or header bag, read against the secrets it REFERS to and not
 * against the config alone. The config holds `$secret:` references, and the
 * panel writes one for every key row even where the user left the value blank
 * (`client/components/McpServerSettings/utils/payload.ts:45`) — so a bag that
 * looks configured is exactly the state an agent is asked to diagnose. One
 * unresolved reference stops the server (`session/mcp-resolve.ts:60`), so a
 * partly-set bag is reported as not configured, with a count of how many are
 * missing. The count is ShipIt's own; the keys are the user's and stay out.
 */
function mcpSecretBag(
  ctx: StoreReadContext,
  bag: Record<string, string> | null,
): { raw: unknown; notes: string[] } {
  const entries = Object.entries(bag ?? {});
  if (entries.length === 0) return { raw: null, notes: [] };
  const env = ctx.deps.credentialStore ? collectMcpAgentEnv(ctx.deps.credentialStore) : {};
  const unresolved = entries.filter(([, value]) => {
    const missing: string[] = [];
    substituteMcpPlaceholders(value, env, missing);
    return missing.length > 0;
  }).length;
  if (unresolved === 0) return { raw: bag, notes: [] };
  return {
    raw: null,
    notes: [
      `${unresolved} of ${entries.length} ${entries.length === 1 ? "entry" : "entries"} refers to a `
        + "stored value ShipIt does not have, so this server cannot start until it is set.",
    ],
  };
}

/** `env` for a stdio server, `headers` for an HTTP one; both are the same bag. */
function mcpSecretItems(
  ctx: StoreReadContext,
  cache: StoreReadCache,
  pick: (server: McpServerConfig) => Record<string, string> | null,
): StoredRead {
  const missing = needsCredentialStore(ctx);
  if (missing) return missing;
  return items(
    cache.mcpServers().map((server) => {
      const read = mcpSecretBag(ctx, pick(server));
      return {
        name: { kind: "stored" as const, item: server },
        raw: read.raw,
        ...(read.notes.length > 0 ? { notes: read.notes } : {}),
      };
    }),
  );
}

// Project -------------------------------------------------------------------

/**
 * A per-repository read never resolves a repository the agent supplies: the
 * session's own binding is the only source, and an unbound session is answered
 * by `scopeUnreadableReason` before a reader is reached.
 */
function projectValue(
  ctx: StoreReadContext,
  read: (repoUrl: string) => StoredRead,
): StoredRead {
  const { repoUrl } = ctx;
  if (!repoUrl) {
    return unreadable("This session binds no repository, so there is no value to read.");
  }
  return read(repoUrl);
}

function repoField(
  ctx: StoreReadContext,
  field: (repo: { allowAgentMerge?: boolean; colorIndex?: number }) => unknown,
): StoredRead {
  return projectValue(ctx, (repoUrl) => {
    const store = ctx.deps.repoStore;
    if (!store) {
      return unreadable("This install has no repository store, so ShipIt cannot read this value.");
    }
    const repo = store.get(repoUrl);
    if (!repo) {
      return unreadable("ShipIt has no record of this session's repository, so there is no value to read.");
    }
    return value(field(repo));
  });
}

function secretItems(
  ctx: StoreReadContext,
  cache: StoreReadCache,
  field: (name: string) => unknown,
): StoredRead {
  return projectValue(ctx, () => {
    if (!ctx.deps.secretStore) {
      return unreadable("This install has no secret store, so ShipIt cannot read this value.");
    }
    return items(
      cache.secretNames().map((name) => ({
        // Named through `project.secrets`, which emits these same names.
        name: { kind: "stored" as const, item: name },
        raw: field(name),
      })),
    );
  });
}

/**
 * A reader for every declaration a panel of its own owns, keyed by declaration
 * key rather than by owner.
 *
 * **The key set is DERIVED from the catalogue, not restated here**
 * (`BespokeSettingKey`, docs/299-agent-settings-access req 7). A reader table
 * keyed independently would be a second registry — the eighth place this
 * feature exists to remove — and a declaration added without an entry would
 * simply report itself unreadable forever. With the key type derived, that
 * omission is a missing property at compile time, and a reader for a setting
 * nobody declared is an unknown one. {@link bespokeReader} is how a caller
 * holding a plain string looks one up.
 */
export const BESPOKE_READERS: Record<BespokeSettingKey, StoreReader> = {
  // Roles.
  "roles": (ctx, cache) => {
    const missing = needsCredentialStore(ctx);
    return missing ?? value(cache.roles());
  },
  "roles[].name": (ctx, cache) => roleItems(ctx, cache, (role) => role.name),
  "roles[].model": (ctx, cache) => roleItems(ctx, cache, rolePinnedSelection),
  "roles[].harness": (ctx, cache) =>
    roleItems(ctx, cache, (role) => (role.params.kind === "pinned" ? role.params.harnessId : null)),
  "roles[].reasoningEffort": (ctx, cache) =>
    roleItems(ctx, cache, (role) =>
      role.params.kind === "pinned" ? role.params.reasoningEffort ?? null : null),
  "roles[].description": (ctx, cache) => roleItems(ctx, cache, (role) => role.description ?? ""),
  "roles[].prompt": (ctx, cache) => roleItems(ctx, cache, (role) => role.prompt ?? ""),

  // Reviewer slots.
  "reviewers": (ctx, cache) => {
    const missing = needsCredentialStore(ctx);
    return missing ?? value(cache.reviewerSlots());
  },
  "reviewers[].model": (ctx, cache) =>
    reviewerItems(ctx, cache, (slot) =>
      slot.pin
        ? { serviceId: slot.pin.serviceId, billingMode: slot.pin.billingMode, modelId: slot.pin.modelId }
        : null),
  "reviewers[].reasoningEffort": (ctx, cache) =>
    reviewerItems(ctx, cache, (slot) => slot.pin?.reasoningEffort ?? null),

  // Credential routing.
  "services.credentials": (ctx, cache) =>
    modeItems(ctx, cache, (pair) =>
      cache
        .stringRoutes()
        .filter((r) => r.serviceId === pair.serviceId && r.billingMode === pair.billingMode)),
  "services.accountSelectionMode": (ctx, cache) =>
    modeItems(ctx, cache, (pair) =>
      ctx.deps.credentialStore?.getSelectionMode(pair.serviceId, pair.billingMode)),
  "services.failoverCutoff.session": (ctx, cache) =>
    modeItems(ctx, cache, (pair) =>
      ctx.deps.credentialStore?.getFailoverCutoffs(pair.serviceId, pair.billingMode).session),
  "services.failoverCutoff.weekly": (ctx, cache) =>
    modeItems(ctx, cache, (pair) =>
      ctx.deps.credentialStore?.getFailoverCutoffs(pair.serviceId, pair.billingMode).weekly),
  "services.credentials[].label": (ctx, cache) => routeItems(ctx, cache, (route) => route.label),
  // The stored secret itself, through the door: `configured_only` is what
  // reduces it to whether it is set, and a reader deciding that here would be
  // the second formatter req 2 forbids.
  "services.credentials[].secret": (ctx, cache) =>
    routeItems(ctx, cache, (route) => ctx.deps.credentialStore?.getCredentialSecret(route.id) ?? null),

  // Provider accounts.
  "services.providerAccounts": (ctx, cache) => {
    if (!ctx.deps.providerAccountManager) {
      return unreadable("This install has no provider accounts, so ShipIt cannot read this value.");
    }
    const byService = new Map<string, CredentialRoute[]>();
    for (const account of cache.providerAccounts()) {
      byService.set(account.serviceId, [...(byService.get(account.serviceId) ?? []), account]);
    }
    return items(
      [...byService].map(([serviceId, accounts]) => ({
        name: { kind: "shipit" as const, address: serviceId },
        raw: accounts,
      })),
    );
  },
  // "ready" is the one status that means signed in; anything else reads as not
  // configured, and the note carries which it is.
  "services.providerAccounts[].connection": (ctx, cache) =>
    accountItems(ctx, cache, (account) => (account.status === "ready" ? account.status : null)),
  "services.providerAccounts[].label": (ctx, cache) =>
    accountItems(ctx, cache, (account) => account.label),

  // MCP.
  "mcp.servers": (ctx, cache) => {
    const missing = needsCredentialStore(ctx);
    return missing ?? value(cache.mcpServers());
  },
  "mcp.servers[].name": (ctx, cache) => mcpItems(ctx, cache, (server) => server.name),
  "mcp.servers[].type": (ctx, cache) => mcpItems(ctx, cache, (server) => server.type),
  "mcp.servers[].enabled": (ctx, cache) => mcpItems(ctx, cache, (server) => server.enabled),
  "mcp.servers[].command": (ctx, cache) => mcpItems(ctx, cache, (s) => stdioField(s, "command")),
  "mcp.servers[].args": (ctx, cache) => mcpItems(ctx, cache, (s) => stdioField(s, "args")),
  "mcp.servers[].npmPackage": (ctx, cache) => mcpItems(ctx, cache, (s) => stdioField(s, "npmPackage")),
  "mcp.servers[].url": (ctx, cache) =>
    mcpItems(ctx, cache, (server) => (server.type === "http" ? server.url : null)),
  "mcp.servers[].env": (ctx, cache) =>
    mcpSecretItems(ctx, cache, (server) => (server.type === "stdio" ? server.env ?? null : null)),
  "mcp.servers[].headers": (ctx, cache) =>
    mcpSecretItems(ctx, cache, (server) => (server.type === "http" ? server.headers ?? null : null)),
  "mcp.oauthProvider": (ctx) => {
    const credentialStore = ctx.deps.credentialStore;
    if (!credentialStore) return unreadable(NO_CREDENTIAL_STORE);
    return items(
      listMcpOAuthProviders(credentialStore).map(({ provider }) => ({
        name: { kind: "shipit" as const, address: provider.id },
        raw: credentialStore.getMcpOAuthTokens(provider.id) ?? null,
      })),
    );
  },

  // The two pasted-token integrations.
  "integrations.github.connection": (ctx) => {
    const missing = needsCredentialStore(ctx);
    return missing ?? value(ctx.deps.credentialStore?.getGithubToken() ?? null);
  },
  "integrations.linear.credential": (ctx) => {
    const missing = needsCredentialStore(ctx);
    return missing ?? value(ctx.deps.credentialStore?.getLinearToken() ?? null);
  },

  // The global egress allowlist.
  "network.egress.hosts": (ctx, cache) =>
    ctx.deps.egressAllowlistStore
      ? value(cache.globalAllowlist())
      : unreadable("This install has no egress allowlist store, so ShipIt cannot read this value."),
  "network.egress.hosts[].host": (ctx, cache) =>
    ctx.deps.egressAllowlistStore
      ? items(
          cache.globalAllowlist().map((host) => ({
            // Named through `network.egress.hosts`, whose projection drops an
            // entry that is not shaped like a host — so a URL pasted into the
            // box is named by nothing and has no item here either.
            name: { kind: "stored" as const, item: host },
            raw: host,
          })),
        )
      : unreadable("This install has no egress allowlist store, so ShipIt cannot read this value."),

  // Voice credentials.
  "voice.providerKey": (ctx) => {
    const credentialStore = ctx.deps.credentialStore;
    if (!credentialStore) return unreadable(NO_CREDENTIAL_STORE);
    return items(
      keyRequiringProviders().map((provider) => ({
        name: { kind: "shipit" as const, address: provider.id },
        raw: credentialStore.getVoiceProviderKey(provider.id),
      })),
    );
  },
  "voice.webhook.url": (ctx) => {
    const missing = needsCredentialStore(ctx);
    return missing ?? value(ctx.deps.credentialStore?.getVoiceWebhook()?.url ?? null);
  },
  "voice.webhook.token": (ctx) => {
    const missing = needsCredentialStore(ctx);
    return missing ?? value(ctx.deps.credentialStore?.getVoiceWebhook()?.token ?? null);
  },

  // Project Settings.
  "project.allowAgentMerge": (ctx) => repoField(ctx, (repo) => repo.allowAgentMerge ?? false),
  "project.colorIndex": (ctx) => repoField(ctx, (repo) => repo.colorIndex ?? null),
  "project.secrets": (ctx, cache) =>
    projectValue(ctx, () =>
      ctx.deps.secretStore
        ? value(cache.secretNames())
        : unreadable("This install has no secret store, so ShipIt cannot read this value.")),
  "project.secrets[].name": (ctx, cache) => secretItems(ctx, cache, (name) => name),
  // The stored value, through the door: `configured_only` reduces it to whether
  // the name has one, and nothing else here ever touches it.
  "project.secrets[].value": (ctx, cache) =>
    secretItems(ctx, cache, (name) => cache.secretValues()[name] ?? null),
};

/** The reader for a key held as a plain string; present for every bespoke one. */
export function bespokeReader(key: string): StoreReader | undefined {
  return (BESPOKE_READERS as Record<string, StoreReader | undefined>)[key];
}
