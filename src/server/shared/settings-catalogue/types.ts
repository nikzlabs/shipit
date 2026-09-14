/**
 * One declaration per setting (docs/299-agent-settings-access req 7). The stored
 * half of `GlobalSettings`, the `PUT /api/settings` body and `CredentialStore`'s
 * read/write all derive from it, so an undeclared setting has no payload field
 * and cannot be saved. The dialog renders from the same declaration — its label
 * and description are these two fields — and `settings-coverage.test.tsx` fails
 * on a control that is neither bound to one nor named in `exclusions.ts`.
 */

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
  | { readonly kind: "configured_only" }
  | {
      readonly kind: "derived";
      /** What the function emits, for a reader checking it against the value. */
      readonly describes: string;
      readonly project: (raw: unknown) => unknown;
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
  | { readonly ok: false; readonly message: string };

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

/** Written by a route of its own, so the settings payload does not carry it. */
export interface OwnRouteStore {
  readonly kind: "own-route";
  readonly route: string;
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

export function configuredOnly(): Projection {
  return { kind: "configured_only" };
}

/** Emits what the function returns and nothing else. */
export function derived(describes: string, project: (raw: unknown) => unknown): Projection {
  return { kind: "derived", describes, project };
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
