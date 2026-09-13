import type { CredentialStore } from "../credential-store.js";
import { getGitIdentity, setGitIdentity as writeGitIdentity } from "../git-config.js";
import { readGlobalSystemPrompt, writeGlobalSystemPrompt } from "../global-system-prompt.js";
import { payloadDeclarations } from "../../shared/settings-catalogue/index.js";
import type {
  AnyPayloadDeclaration,
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
    case "system-prompt-file":
      return type.read(await readGlobalSystemPrompt(ctx.appWorkspaceDir, store.promptScope));
    case "git-config":
      return type.read(getGitIdentity());
  }
}

export async function readStoredGlobalSettings(
  ctx: SettingsDerivationContext,
): Promise<StoredGlobalSettings> {
  const out: Record<string, unknown> = {};
  for (const declaration of payloadDeclarations()) {
    const value = await readDeclared(declaration, ctx);
    // A pin the payload has always omitted rather than sent as null.
    if (value === null && declaration.omitWhenNull) continue;
    out[declaration.wire] = value;
  }
  return out as StoredGlobalSettings;
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

export async function writeDeclaredSetting(
  write: DeclaredSettingWrite,
  ctx: SettingsDerivationContext,
): Promise<void> {
  const { declaration, value } = write;
  const { store } = declaration;
  switch (store.kind) {
    case "credential-store":
      if (!ctx.credentialStore) throw new ServiceError(500, "No credential store is configured");
      ctx.credentialStore.setDeclaredSetting(
        declaration.key as CredentialStoreSettingKey,
        value,
      );
      return;
    case "system-prompt-file":
      await writeGlobalSystemPrompt(ctx.appWorkspaceDir, value as string, store.promptScope);
      return;
    case "git-config": {
      const identity = value as { name: string; email: string };
      writeGitIdentity(identity.name, identity.email);
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
