import type { CredentialStore } from "../credential-store.js";
import { readGitIdentity, setGitIdentity as writeGitIdentity } from "../git-config.js";
import { readGlobalSystemPrompt, writeGlobalSystemPrompt } from "../global-system-prompt.js";
import { payloadDeclarations } from "../../shared/settings-catalogue/index.js";
import type {
  AnyPayloadDeclaration,
  ApplyOutcome,
  CredentialStoreSettingKey,
  GlobalSettingsPatch,
  StoredGlobalSettings,
} from "../../shared/settings-catalogue/index.js";
import { ServiceError } from "./types.js";

// The stored half of the global settings payload, read, validated and written
// straight from the catalogue (docs/299-agent-settings-access req 7).

export interface SettingsDerivationContext {
  /** Absent before a store exists; every setting then reads as its declared default. */
  credentialStore?: CredentialStore;
  /** Orchestrator workspace holding the instructions files. */
  appWorkspaceDir: string;
}

type Declaration = AnyPayloadDeclaration;

export interface DeclaredSettingWrite {
  declaration: Declaration;
  /** Already validated against the declaration's type. */
  value: unknown;
}

/**
 * A reader that could not tell throws here rather than answering with the
 * declared default, so `readStoredGlobalSettings` can report THAT setting
 * unreadable (docs/299-agent-settings-access req 1). The two file-backed stores
 * used to swallow their own failures, and an `EACCES` on an existing
 * instructions file read as *no instructions*.
 */
async function readDeclared(
  declaration: Declaration,
  ctx: SettingsDerivationContext,
): Promise<unknown> {
  const { store, type } = declaration;
  switch (store.kind) {
    case "credential-store":
      return ctx.credentialStore
        ? ctx.credentialStore.getDeclaredSetting(declaration.key as CredentialStoreSettingKey)
        : type.defaultValue;
    case "system-prompt-file": {
      const read = await readGlobalSystemPrompt(ctx.appWorkspaceDir, store.promptScope);
      if (!read.ok) throw read.error;
      return type.read(read.content);
    }
    case "git-config": {
      const read = readGitIdentity();
      if (!read.ok) throw read.error;
      return type.read(read.identity);
    }
  }
}

export interface StoredGlobalSettingsRead {
  values: StoredGlobalSettings;
  /**
   * The wire names whose own reader could not tell. `values` still carries the
   * declared default for these, because a caller rendering the dialog needs a
   * complete payload — but a caller REPORTING a value must say it could not be
   * read instead of passing that default off as the truth.
   */
  unreadable: ReadonlySet<string>;
}

export async function readStoredGlobalSettings(
  ctx: SettingsDerivationContext,
): Promise<StoredGlobalSettingsRead> {
  const out: Record<string, unknown> = {};
  const unreadable = new Set<string>();
  for (const declaration of payloadDeclarations()) {
    let value: unknown;
    try {
      value = await readDeclared(declaration, ctx);
    } catch (err) {
      // Per declaration, never per call: one unreadable file must not cost the
      // caller every other setting's value.
      console.error(`[settings] reading ${declaration.key} failed:`, err);
      unreadable.add(declaration.wire);
      value = declaration.type.defaultValue;
    }
    // A pin the payload has always omitted rather than sent as null.
    if (value === null && declaration.omitWhenNull) continue;
    out[declaration.wire] = value;
  }
  return { values: out as StoredGlobalSettings, unreadable };
}

/**
 * Validate every declared value the caller supplied, before anything is written:
 * one over-long box must not leave the other half of a tab persisted.
 */
export function validateDeclaredSettings(values: GlobalSettingsPatch): DeclaredSettingWrite[] {
  const writes: DeclaredSettingWrite[] = [];
  const source = values as Record<string, unknown>;
  for (const declaration of payloadDeclarations()) {
    const raw = source[declaration.wire];
    if (raw === undefined) continue;
    const checked = declaration.type.validate(raw, declaration.label);
    if (!checked.ok) throw new ServiceError(400, checked.message);
    writes.push({ declaration, value: checked.value });
  }
  return writes;
}

/**
 * Each store answers for its own durability (docs/299 → "Saved" has to mean
 * saved): the credential store rolls a failed disk write back, clearing the
 * instructions can fail with the old file still in place, and the git identity
 * is two writes of which the first can land alone.
 */
export async function writeDeclaredSetting(
  write: DeclaredSettingWrite,
  ctx: SettingsDerivationContext,
): Promise<ApplyOutcome> {
  const { declaration, value } = write;
  const { store } = declaration;
  switch (store.kind) {
    case "credential-store": {
      if (!ctx.credentialStore) throw new ServiceError(500, "No credential store is configured");
      const credentialStore = ctx.credentialStore;
      return credentialStore.transact(() => {
        credentialStore.setDeclaredSetting(declaration.key as CredentialStoreSettingKey, value);
      }).outcome;
    }
    case "system-prompt-file":
      return writeGlobalSystemPrompt(ctx.appWorkspaceDir, value as string, store.promptScope);
    case "git-config": {
      const identity = value as { name: string; email: string };
      return writeGitIdentity(identity.name, identity.email);
    }
  }
}

/**
 * The value a write is about to replace. Synchronous on purpose: an awaited read
 * lets a concurrent save land in between, and the hook then sees a value that is
 * already its own. Only credential-store settings can be read this way, which is
 * why a save hook wanting `previous` has to be one.
 */
export function currentDeclaredValue(
  declaration: Declaration,
  credentialStore: CredentialStore,
): unknown {
  if (declaration.store.kind !== "credential-store") {
    throw new Error(`${declaration.key} is not persisted by the credential store`);
  }
  return credentialStore.getDeclaredSetting(declaration.key as CredentialStoreSettingKey);
}

/** Only the body fields the catalogue declares; anything else cannot be saved. */
export function pickDeclaredSettings(body: unknown): GlobalSettingsPatch {
  const source = (body ?? {}) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const declaration of payloadDeclarations()) {
    if (source[declaration.wire] !== undefined) picked[declaration.wire] = source[declaration.wire];
  }
  return picked;
}
