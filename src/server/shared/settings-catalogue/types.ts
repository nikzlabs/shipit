/**
 * One declaration per setting (docs/299-agent-settings-access req 7). The stored
 * half of `GlobalSettings`, the `PUT /api/settings` body and `CredentialStore`'s
 * read/write all derive from it, so an undeclared setting has no payload field
 * and cannot be saved. Binding the dialog to the same declaration, which is what
 * would stop a control being built without one, is a later slice.
 */

export type SettingScope = "global" | "project" | "browser";

/** The dialog tab a setting appears on (plan.md → Scope inventory). */
export type SettingTab =
  | "services"
  | "roles"
  | "integrations"
  | "git"
  | "instructions"
  | "keyboard"
  | "voice"
  | "network"
  | "advanced"
  | "project-deployments"
  | "project-secrets"
  | "project-appearance";

/** Why the agent may not propose this change (plan.md → Refusals are first-class). */
export type ProposeRefusal =
  /** Credential material the agent does not have. */
  | "secret"
  /** Needs an OAuth or device-code flow on the provider's site. */
  | "external_flow"
  /** The value lives in the browser, not on the server. */
  | "browser_local"
  /** The card cannot show the operation's full effect, so the user cannot approve it by looking. */
  | "unsafe_to_display";

export type ProposeDescriptor =
  | { readonly kind: "yes" }
  | { readonly kind: "no"; readonly reason: ProposeRefusal };

/**
 * The only output this setting may produce. A projection emits values ShipIt
 * derived, never user-supplied free text — `user_text` is the marked exception,
 * and its reason is what review reads.
 */
export type Projection =
  | { readonly kind: "plain" }
  | { readonly kind: "user_text"; readonly reason: string }
  | { readonly kind: "configured_only" };

export type SettingValueKind =
  | "bool"
  | "enum"
  | "number"
  | "text"
  | "gitIdentity"
  | "modelSelection"
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

export type SettingStore<T> = PayloadSettingStore<T> | OwnRouteStore;

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
}

export interface PayloadSettingDeclaration<T> extends SettingDeclarationBase<T> {
  readonly store: PayloadSettingStore<T>;
  /** The `GlobalSettings` and `PUT /api/settings` field derived from this setting. */
  readonly wire: string;
  /** The payload omits the field when the value is null, rather than sending null. */
  readonly omitWhenNull?: boolean;
}

export interface OwnRouteSettingDeclaration<T> extends SettingDeclarationBase<T> {
  readonly store: OwnRouteStore;
  /** The payload does not carry this setting, so it has no field to name. */
  readonly wire?: never;
}

export type SettingDeclaration<T> =
  | PayloadSettingDeclaration<T>
  | OwnRouteSettingDeclaration<T>;

/** The registry's element type: any declared value, any store. */
export interface AnySettingDeclaration extends SettingDeclarationBase<unknown> {
  readonly store: AnyPayloadStore | OwnRouteStore;
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

export function isPayloadDeclaration(
  declaration: AnySettingDeclaration,
): declaration is AnyPayloadDeclaration {
  return declaration.store.kind !== "own-route";
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
