/**
 * One declaration per setting (docs/299-agent-settings-access req 7). The stored
 * half of `GlobalSettings`, the `PUT /api/settings` body and `CredentialStore`'s
 * read/write all derive from it, so an undeclared setting has no payload field
 * and cannot be saved. The dialog renders from the same declaration — its label
 * and description are these two fields.
 */

import type { Rendered } from "./rendered.js";

export type SettingScope = "global" | "project" | "browser";

/** The dialog tab a setting appears on (plan.md → Scope inventory). */
export type SettingTab =
  | "services"
  | "roles"
  | "integrations"
  | "git"
  | "instructions"
  | "skills"
  | "keyboard"
  | "voice"
  | "network"
  | "advanced"
  | "project-deployments"
  | "project-secrets"
  | "project-appearance";

/**
 * Why a setting cannot be read as a value, or cannot be proposed
 * (plan.md → Refusals are first-class). The same four reasons serve both: a
 * browser-local value is withheld from the read AND unproposable, for one
 * reason and not two.
 */
export type RefusalReason =
  /** Credential material the agent does not have. */
  | "secret"
  /** Needs an OAuth or device-code flow on the provider's site. */
  | "external_flow"
  /** The value lives in the browser, not on the server. */
  | "browser_local"
  /** The card cannot show the operation's full effect, so the user cannot approve it by looking. */
  | "unsafe_to_display";

export type ProposeRefusal = RefusalReason;

export type ProposeDescriptor =
  | { readonly kind: "yes" }
  | { readonly kind: "no"; readonly reason: ProposeRefusal };

/**
 * The only output this setting may produce. A projection emits values ShipIt
 * derived, never user-supplied free text — `user_text` is the marked exception,
 * and its reason is what review reads.
 *
 * A field-name deny-list cannot work here: an MCP entry takes arbitrary `args`,
 * `env`, `headers` and a URL, so a token lives in a field called `args`
 * (`services/mcp.ts:49`, `:63`). `derived` is the allowlist — its function is
 * the only thing that produces output, so a field it does not read cannot leak.
 */
export type Projection =
  | { readonly kind: "plain" }
  | { readonly kind: "user_text"; readonly reason: string }
  /**
   * The user's own name for something, emitted only when it is shaped like a
   * name — `user_text` plus the shape gate `projection.ts` documents. Every
   * name a collection ADDRESSES an item by is one of these.
   */
  | { readonly kind: "user_name"; readonly reason: string }
  | { readonly kind: "configured_only" }
  | {
      readonly kind: "derived";
      /** What the function emits, for a reader checking it against the value. */
      readonly describes: string;
      readonly project: (raw: unknown) => unknown;
      /**
       * Present when what the function emits is the user's own text rather than
       * something ShipIt computed — the same mark `user_text` carries, for the
       * same reason: it is what review reads.
       */
      readonly userText?: string;
      /** Present instead, when the output is ShipIt's own: why it is. */
      readonly computed?: string;
    }
  | { readonly kind: "withheld"; readonly reason: RefusalReason };

export type SettingValueKind =
  | "bool"
  | "enum"
  | "number"
  | "text"
  | "gitIdentity"
  | "modelSelection"
  | "secretBag"
  | "collection";

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  /** {@link Rendered} because a refusal is a line the agent reads, and the text it names is the write's own. */
  | { readonly ok: false; readonly message: Rendered };

export interface SettingValueType<T> {
  readonly kind: SettingValueKind;
  readonly defaultValue: T;
  /** Detail `shipit settings get` renders; the index never carries it. */
  readonly shape: Readonly<Record<string, unknown>>;
  /** Interpret a persisted value; anything that is not one reads as the default. */
  read(raw: unknown): T;
  /** Validate an incoming write. `noun` names the setting in the message. */
  validate(raw: unknown, noun: string): ValidationResult<T>;
  /** The persisted form. `undefined` removes the stored field. */
  serialize(value: T): unknown;
}

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Stores the global settings payload reads and writes. A store is admissible
 * only for a value type it can hold, so a declaration cannot bind a boolean to
 * the git config and leave the writer to cast it.
 */
export type PayloadSettingStore<T> =
  | { readonly kind: "credential-store"; readonly field: string }
  | ([T] extends [string] ? { readonly kind: "system-prompt-file"; readonly promptScope: "standard" | "ops" } : never)
  | ([T] extends [GitIdentity] ? { readonly kind: "git-config" } : never);

/**
 * Written by a route of its own, so the settings payload does not carry it.
 *
 * An address rather than a sentence (inventory.md P2): the two settings stored
 * this way post *different* body shapes and neither carries a `wire`, so a
 * client reading a route string could work out neither the payload to send nor
 * the field to read back. The write is `method path` with
 * `{ [bodyField]: value }`; the read is a GET of the same path, answering the
 * same field.
 */
export interface OwnRouteStore {
  readonly kind: "own-route";
  readonly method: "POST" | "PUT";
  readonly path: string;
  readonly bodyField: string;
  /**
   * The path STORES this value and never answers it, so the read above does not
   * exist for it. A credential the user pastes is the case: `POST
   * /api/github/token` takes a token and no GET hands one back.
   *
   * It is what keeps such a setting out of the browser's value record — nothing
   * would hydrate it, and the own-route read would otherwise ask a path with no
   * GET on every settings refresh. **`emits: configuredOnly()` is not this
   * fact**: that is the AGENT's projection, and the voice webhook's URL is
   * `configuredOnly` and read back in full (inventory.md → Four kinds of
   * control).
   */
  readonly writeOnly?: true;
}

/**
 * A panel of its own reads and writes the value — the role editor, the MCP
 * panel, the credential rows, the secrets table, Project Settings — so the
 * derived payload has no single field for it. `ownedBy` names where the value
 * lives, for a reader following it.
 */
export interface BespokeStore {
  readonly kind: "bespoke";
  readonly ownedBy: string;
}

/** The value is in `localStorage`; ShipIt's server never holds it. */
export interface BrowserStore {
  readonly kind: "browser";
  readonly localStorageKey: string;
}

/** Everything the derived global payload does not carry. */
export type NonPayloadStore = OwnRouteStore | BespokeStore | BrowserStore;

export type SettingStore<T> = PayloadSettingStore<T> | NonPayloadStore;

/**
 * What identifies one instance of this setting. A key alone is not enough:
 * `project.allowAgentMerge` exists once per repository and
 * `mcp.servers[].enabled` once per server (plan.md → The target, and the lock).
 * A repository address is resolved from the session's own binding, never from
 * anything the agent supplies.
 */
export type SettingAddress =
  | { readonly kind: "none" }
  | { readonly kind: "repository" }
  | { readonly kind: "item"; readonly noun: string }
  /** One item inside the session's repository — a secret name, say. */
  | { readonly kind: "repository-item"; readonly noun: string };

export function itemAddress(noun: string): SettingAddress {
  return { kind: "item", noun };
}

export function repositoryItemAddress(noun: string): SettingAddress {
  return { kind: "repository-item", noun };
}

export const REPOSITORY_ADDRESS: SettingAddress = { kind: "repository" };

/** True for the two addresses a project setting may carry. */
export function addressesARepository(address: SettingAddress | undefined): boolean {
  return address?.kind === "repository" || address?.kind === "repository-item";
}

/** Every store kind, for code that handles declarations of any value type. */
export type AnyPayloadStore =
  | { readonly kind: "credential-store"; readonly field: string }
  | { readonly kind: "system-prompt-file"; readonly promptScope: "standard" | "ops" }
  | { readonly kind: "git-config" };

interface SettingDeclarationBase<T> {
  readonly key: string;
  readonly tab: SettingTab;
  /**
   * The headed group this row joins on its tab, omitted where the tab has none.
   * A group's place is where its first declaration is, so order and grouping
   * both come from the catalogue (docs/308-data-driven-settings req 11).
   */
  readonly section?: string;
  /**
   * Where this row sits on its tab when declaration order alone cannot say:
   * lower first, unset meaning 0, and declaration order deciding within a rank
   * (VS Code's `order`, taken at last after being skipped — see
   * docs/308-data-driven-settings plan.md → Placement).
   *
   * It exists because three rows led tabs they cannot lead, and the free fix
   * does not reach them: a group's place is its first declaration's place, but
   * a declaration can only MOVE inside its own file, and `GLOBAL_SETTINGS` is
   * the registry's first source. Every payload scalar therefore leads its tab,
   * and a payload scalar cannot leave `global-settings.ts` without dropping out
   * of the derived `GlobalSettings` types (`global-settings.ts:306`).
   */
  readonly order?: number;
  /**
   * The component that renders this setting, for one whose editing needs its own
   * logic (docs/308-data-driven-settings req 3). Custom is what it LOOKS like:
   * the declaration and the store are the ones every generated row uses. One
   * component may be named by several declarations and renders once.
   */
  readonly component?: string;
  readonly scope: SettingScope;
  /** The dialog renders these two, and the agent reads the same words (req 7). */
  readonly label: string;
  readonly description: string;
  readonly type: SettingValueType<T>;
  readonly emits: Projection;
  readonly propose: ProposeDescriptor;
  /** Absent means the setting exists once, with nothing to address. */
  readonly address?: SettingAddress;
}

export interface PayloadSettingDeclaration<T> extends SettingDeclarationBase<T> {
  readonly store: PayloadSettingStore<T>;
  /** The `GlobalSettings` and `PUT /api/settings` field derived from this setting. */
  readonly wire: string;
  /** The payload omits the field when the value is null, rather than sending null. */
  readonly omitWhenNull?: boolean;
}

export interface NonPayloadSettingDeclaration<T> extends SettingDeclarationBase<T> {
  readonly store: NonPayloadStore;
  /** The payload does not carry this setting, so it has no field to name. */
  readonly wire?: never;
}

export type SettingDeclaration<T> =
  | PayloadSettingDeclaration<T>
  | NonPayloadSettingDeclaration<T>;

/** The registry's element type: any declared value, any store. */
export interface AnySettingDeclaration extends SettingDeclarationBase<unknown> {
  readonly store: AnyPayloadStore | NonPayloadStore;
  readonly wire?: string;
  readonly omitWhenNull?: boolean;
}

/** A registry entry the global settings payload carries. */
export interface AnyPayloadDeclaration extends AnySettingDeclaration {
  readonly store: AnyPayloadStore;
  readonly wire: string;
}

/** The value type a declaration carries. */
export type SettingValue<D> = D extends { readonly type: SettingValueType<infer T> } ? T : never;

const PAYLOAD_STORE_KINDS: ReadonlySet<string> = new Set<AnyPayloadStore["kind"]>([
  "credential-store",
  "system-prompt-file",
  "git-config",
]);

/**
 * Named positively: a store kind added for a panel of its own must not reach
 * the derived payload by being spelled differently from the one exclusion a
 * negative test would have listed.
 */
export function isPayloadDeclaration(
  declaration: AnySettingDeclaration,
): declaration is AnyPayloadDeclaration {
  return PAYLOAD_STORE_KINDS.has(declaration.store.kind);
}

export function plain(): Projection {
  return { kind: "plain" };
}

/** The value is the user's own prose, shown because it is theirs. */
export function userText(reason: string): Projection {
  return { kind: "user_text", reason };
}

/**
 * The user's own name for something, shown because naming it is the point —
 * and only when it is shaped like a name, so a pasted URL is named by nothing.
 */
export function userName(reason: string): Projection {
  return { kind: "user_name", reason };
}

export function configuredOnly(): Projection {
  return { kind: "configured_only" };
}

/**
 * Where a `derived` projection's output comes from — whose text it is.
 *
 * **Exactly one, and neither is optional** (docs/299-agent-settings-access
 * req 2). `userText` used to be an optional third argument, so a projection that
 * emitted the user's own text simply by forgetting it claimed to emit something
 * ShipIt computed, which is what review reads. Two shipped that way:
 * `integrations.sshHosts` emitted a destination's label and
 * `network.egress.hosts[].host` an allowlist entry, both unmarked. A required
 * argument is the only form of this rule that cannot be forgotten — omitting it
 * does not compile.
 */
export type DerivedOrigin =
  /** The output is the user's own text; the reason it is shown anyway. */
  | { readonly userText: string }
  /** The output is ShipIt's own — an id, a parse, a count — and why that is so. */
  | { readonly shipItComputed: string };

/** Emits what the function returns and nothing else, with whose text that is. */
export function derived(
  describes: string,
  project: (raw: unknown) => unknown,
  origin: DerivedOrigin,
): Projection {
  return {
    kind: "derived",
    describes,
    project,
    ...("userText" in origin ? { userText: origin.userText } : { computed: origin.shipItComputed }),
  };
}

/** The read has no value to give: a browser-local setting, or secret material. */
export function withheld(reason: RefusalReason): Projection {
  return { kind: "withheld", reason };
}

/**
 * Preserves a declaration's literal types, so the wire key and the value type
 * can be read back off the registry. The intersection is the check: the store
 * has to be one this declaration's value type can live in.
 */
export function defineSetting<const D extends AnySettingDeclaration>(
  declaration: D & SettingDeclaration<SettingValue<D>>,
): D {
  return declaration;
}
