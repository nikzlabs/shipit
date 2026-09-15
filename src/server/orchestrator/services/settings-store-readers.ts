import { allServices } from "../../shared/catalogue/index.js";
import { substituteMcpPlaceholders } from "../../shared/mcp-placeholders.js";
import { collectMcpAgentEnv } from "../secret-resolver.js";
import { buildEffectiveAllowlist } from "../egress-allowlist.js";
import { EGRESS_GLOBAL_SCOPE } from "../egress-allowlist-store.js";
import { keyRequiringProviders } from "../../shared/voice-catalog.js";
import type { CredentialBillingMode, CredentialRoute } from "../../shared/types.js";
import type { McpServerConfig } from "../../shared/types/mcp-types.js";
import type { ReviewerSlotView, RoleView } from "../../shared/types/agent-types.js";
import type { SshHostPublic } from "../../shared/types/domain-types/ssh.js";
import {
  renderOwn,
  renderValue,
  type BespokeSettingKey,
  type Rendered,
} from "../../shared/settings-catalogue/index.js";
import { buildReviewerSettings } from "./reviewer-settings.js";
import { buildRoleSettings } from "./roles.js";
import { listCredentialRoutes } from "./credential-routes.js";
import { listMcpServers } from "./mcp.js";
import { listMcpOAuthProviders } from "./mcp-oauth.js";
import { grantedSshHosts } from "./ssh.js";
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
  /**
   * ShipIt-derived sentences about this instance; never any of its value.
   *
   * {@link Rendered}, because a note is a LINE of the agent's output like every
   * other (planning#577): `get` prints one per line under the instance it
   * belongs to. The sentences are ShipIt's own, but the facts inside them are
   * not always — a credential route's stored `status` was interpolated into one
   * — so the type carries the guarantee rather than each note's author.
   */
  readonly notes?: readonly Rendered[];
}

export type StoredRead =
  | { readonly kind: "value"; readonly raw: unknown }
  | { readonly kind: "items"; readonly items: StoredItem[] }
  /** No value, and the note says why — never a default standing in for one. */
  | { readonly kind: "unreadable"; readonly note: Rendered };

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

/**
 * Minted here rather than at each call site: this is the only constructor of the
 * variant, so every reason a reader gives leaves through one door and a new
 * reader cannot add a raw one. `renderOwn` flattens rather than trusting its
 * caller, so a note that ever carries a stored fact is safe by construction.
 */
function unreadable(note: string): StoredRead {
  return { kind: "unreadable", note: renderOwn(note) };
}

function needsCredentialStore(ctx: StoreReadContext): StoredRead | null {
  return ctx.deps.credentialStore ? null : unreadable(NO_CREDENTIAL_STORE);
}

// Roles ---------------------------------------------------------------------

function roleNote(role: RoleView): Rendered[] {
  if (role.params.kind === "auto") {
    return [
      renderOwn(
        "ShipIt resolves this role per review from the two reviewer candidate slots, so the role "
          + "itself pins nothing.",
      ),
    ];
  }
  switch (role.unavailableReason) {
    case "stranded":
      return [
        renderOwn(
          `This role names something this install does not have${role.invalidField ? ` (its ${role.invalidField})` : ""}`
            + ", so it cannot run until it is edited.",
        ),
      ];
    case "disconnected":
      return [renderOwn("The credential this role runs on is not connected, so the role cannot run today.")];
    case "quota_exhausted":
      return [renderOwn("Every credential this role could run on is out of quota.")];
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

function reviewerNote(slot: ReviewerSlotView): Rendered[] {
  switch (slot.unavailableReason) {
    case "pin_unavailable":
      // No fallback: `resolveSlotPlan` returns no target for a pinned slot it
      // cannot run (`reviewer-model.ts:311`), so the slot supplies nothing.
      return [
        renderOwn(
          "This slot's pinned model cannot run with the credentials configured, so the slot supplies "
            + "no reviewer at all until the pin is changed, cleared, or made runnable.",
        ),
      ];
    case "nothing_eligible":
      return [renderOwn("No configured credential can run a reviewer, so this slot resolves to nothing.")];
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

/**
 * The one note in this file whose sentence carries something STORED, and the
 * reason the whole notes path is branded (planning#577). `status` is typed as a
 * union and stored as whatever a restore or a migration left there —
 * `credential-store.ts` casts parsed data without validating the field — so the
 * value goes through the value mint, which quotes it and escapes anything that
 * could start a line of its own. The status is what an agent repeats to the
 * user, so it is emitted rather than withheld.
 */
function routeStatusNote(route: CredentialRoute): Rendered[] {
  if (route.status === "ready") return [];
  return [renderOwn(`ShipIt records this credential as ${renderValue(route.status)}.`)];
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
  field: "command" | "npmPackage",
): unknown {
  return server.type === "stdio" ? server[field] ?? null : null;
}

/** One credential-bearing field's stored strings, for the reference check below. */
interface McpReferringField {
  /** What the projection sees when every reference resolves. */
  raw: unknown;
  /** The stored strings, each of which may carry a `$secret:` reference. */
  values: string[];
  /** How one entry of this field is named in the note. */
  noun: { one: string; many: string };
}

const ENTRIES = { one: "entry", many: "entries" };
const ARGUMENTS = { one: "argument", many: "arguments" };

/**
 * The two shapes the MCP panel writes and ShipIt keeps the value of:
 * `mcp__<server>__<KEY>` (`validateMcpSecrets` requires that prefix) and
 * `MCP_PLATFORM_<SOURCE>` from an OAuth flow. Absent here, the likely truth is
 * the one the panel produces — a key row left blank — so this read answers.
 *
 * **Not an ownership claim, and it cannot be one.** A project secret may carry
 * either name and reaches the worker ahead of the account values
 * (`service-secrets-resolver.ts:179` merges project over account, reserving no
 * prefix), so a definite answer here is a judgement about which case is real,
 * not a guarantee. Every OTHER name is not even that: it resolves out of an
 * environment the orchestrator cannot see at all — a Compose snapshot this read
 * has no handle on, plus whatever the container already had, since the worker
 * AUGMENTS its `process.env` rather than replacing it (`session-worker.ts:277`).
 */
function shipItStoresReference(envKey: string): boolean {
  return envKey.startsWith("mcp__") || envKey.startsWith("MCP_PLATFORM_");
}

/**
 * A field read against the secrets it REFERS to and not against the config
 * alone. The config holds `$secret:` references, and the panel writes one for
 * every key row even where the user left the value blank
 * (`client/components/McpServerSettings/utils/payload.ts:45`) — so a field that
 * looks configured is exactly the state an agent is asked to diagnose. One
 * unresolved reference anywhere omits the whole server from the turn
 * (`session/mcp-resolve.ts:41`), so a partly-set field is reported as not
 * configured, with a count of how many are missing. The count is ShipIt's own;
 * the keys are the user's and stay out.
 *
 * **Three fields carry references, not two.** `resolveMcpServer` substitutes a
 * stdio server's `args` and `env` and an HTTP one's `headers`
 * (`session/mcp-resolve.ts:30`, `:31`, `:37`); `command`, `url` and `npmPackage`
 * are not, so a reference in one of them is literal text and blocks nothing.
 *
 * **A reference ShipIt does not store is not a blocker it may report.** This
 * read cannot see the worker's environment (see {@link shipItStoresReference}),
 * so calling such a reference missing states a blocker the server does not have.
 * It says it cannot tell instead, and leans to `configured`, because of the two
 * ways to be wrong about an unknown this is the one that does not send the user
 * to set something already set.
 *
 * The two counts are independent and BOTH notes are emitted: a field carrying a
 * blank key row and a reference to the session's environment has two different
 * things wrong with it, and counting them in one branch drops whichever came
 * second. plan.md → *A reader reads the store the declaration names*.
 */
function mcpReferences(
  ctx: StoreReadContext,
  field: McpReferringField | null,
): { raw: unknown; notes: Rendered[] } {
  if (!field || field.values.length === 0) return { raw: null, notes: [] };
  const env = ctx.deps.credentialStore ? collectMcpAgentEnv(ctx.deps.credentialStore) : {};
  let missingStored = 0;
  let undecidable = 0;
  for (const value of field.values) {
    const unresolved: string[] = [];
    substituteMcpPlaceholders(value, env, unresolved);
    if (unresolved.some(shipItStoresReference)) missingStored++;
    if (unresolved.some((key) => !shipItStoresReference(key))) undecidable++;
  }
  const total = field.values.length;
  const named = (n: number): string => `${n} of ${total} ${total === 1 ? field.noun.one : field.noun.many}`;
  const notes: Rendered[] = [];
  if (missingStored > 0) {
    notes.push(
      renderOwn(
        `${named(missingStored)} refers to a stored value ShipIt does not have, so this server `
          + "cannot start until it is set.",
      ),
    );
  }
  if (undecidable > 0) {
    notes.push(
      renderOwn(
        `${named(undecidable)} refers to a value ShipIt does not store, so it is supplied — or not `
          + "— by the session's own environment, and this read cannot say which.",
      ),
    );
  }
  return { raw: missingStored > 0 ? null : field.raw, notes };
}

/** An environment or header bag: every value of it may be a reference. */
function mcpBag(bag: Record<string, string> | null): McpReferringField | null {
  const values = Object.values(bag ?? {});
  return values.length > 0 ? { raw: bag, values, noun: ENTRIES } : null;
}

/** A stdio server's arguments: every one of them may be a reference. */
function mcpArgs(args: string[] | null): McpReferringField | null {
  return args && args.length > 0 ? { raw: args, values: args, noun: ARGUMENTS } : null;
}

/** `args`, `env` or `headers` — the three fields whose strings are substituted. */
function mcpReferringItems(
  ctx: StoreReadContext,
  cache: StoreReadCache,
  pick: (server: McpServerConfig) => McpReferringField | null,
): StoredRead {
  const missing = needsCredentialStore(ctx);
  if (missing) return missing;
  return items(
    cache.mcpServers().map((server) => {
      const read = mcpReferences(ctx, pick(server));
      return {
        name: { kind: "stored" as const, item: server },
        raw: read.raw,
        ...(read.notes.length > 0 ? { notes: read.notes } : {}),
      };
    }),
  );
}

// SSH destinations ----------------------------------------------------------

/**
 * **The destinations granted to THIS session, never the registry**
 * (docs/305-ssh-hosts). `api-container-guard.ts` hard-denies `/api/ssh-hosts` to
 * every container because "a container has no business … reading the list", and
 * the settings routes are container-accessible — so reading the whole registry
 * here would be that decision undone through another door. `listSshIdentities`
 * scopes the same way, and a granted destination's address, user and port are
 * already in the session's own `~/.ssh/config`.
 *
 * Not cached: a grant is a handful of rows read from memory, unlike the role
 * views a cache entry exists for.
 */
function sessionSshHosts(ctx: StoreReadContext): SshHostPublic[] {
  const credentialStore = ctx.deps.credentialStore;
  if (!credentialStore) return [];
  return grantedSshHosts(
    { credentialStore, sessionManager: ctx.deps.sessionManager },
    ctx.sessionId,
  );
}

/**
 * One field of each granted destination. `SshHostPublic` is the only shape any
 * read path produces, so the private key has no field here to be read by
 * accident (req 3).
 *
 * A session with no grant gets no items, and no count of what it did not get:
 * "4 more destinations" is the enumeration the guard denies, one step weaker.
 * What says why is the collection's own description, which every read carries.
 */
function sshItems(
  ctx: StoreReadContext,
  field: (host: SshHostPublic) => unknown,
): StoredRead {
  const missing = needsCredentialStore(ctx);
  if (missing) return missing;
  return items(
    sessionSshHosts(ctx).map((host) => ({
      // Named through `integrations.sshHosts`, which emits these same labels —
      // so a destination whose label is not shaped like one has no item here
      // either, for the reason that collection's projection gives.
      name: { kind: "stored" as const, item: host },
      raw: field(host),
    })),
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
  "mcp.servers[].args": (ctx, cache) =>
    mcpReferringItems(ctx, cache, (server) => mcpArgs(server.type === "stdio" ? server.args ?? null : null)),
  "mcp.servers[].npmPackage": (ctx, cache) => mcpItems(ctx, cache, (s) => stdioField(s, "npmPackage")),
  "mcp.servers[].url": (ctx, cache) =>
    mcpItems(ctx, cache, (server) => (server.type === "http" ? server.url : null)),
  "mcp.servers[].env": (ctx, cache) =>
    mcpReferringItems(ctx, cache, (server) => mcpBag(server.type === "stdio" ? server.env ?? null : null)),
  "mcp.servers[].headers": (ctx, cache) =>
    mcpReferringItems(ctx, cache, (server) => mcpBag(server.type === "http" ? server.headers ?? null : null)),
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
  // docs/305 — the grant, not the registry; see `sessionSshHosts`.
  "integrations.sshHosts": (ctx) => {
    const missing = needsCredentialStore(ctx);
    return missing ?? value(sessionSshHosts(ctx));
  },
  "integrations.sshHosts[].label": (ctx) => sshItems(ctx, (host) => host.label),
  "integrations.sshHosts[].address": (ctx) => sshItems(ctx, (host) => host.address),
  "integrations.sshHosts[].user": (ctx) => sshItems(ctx, (host) => host.user),
  "integrations.sshHosts[].port": (ctx) => sshItems(ctx, (host) => host.port),
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
