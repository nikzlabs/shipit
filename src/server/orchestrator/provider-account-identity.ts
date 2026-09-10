import fs from "node:fs";
import path from "node:path";
import type { AgentId, CredentialRoute } from "../shared/types.js";
import { nativeServiceForHarness } from "../shared/catalogue/index.js";
import { extractCodexIdentity } from "./agents/codex/auth-manager.js";
import { extractXaiIdentity } from "./agents/grok/auth-manager.js";

export interface ProviderAccountIdentity {
  externalId: string;
  /** Label only: email can change without changing account identity. */
  email?: string;
}

export function readClaudeAccountIdentity(credentialRoot: string): ProviderAccountIdentity | null {
  const config = readJsonObject(path.join(credentialRoot, ".claude.json"));
  const oauthAccount = config?.oauthAccount;
  if (!oauthAccount || typeof oauthAccount !== "object") return null;
  const record = oauthAccount as Record<string, unknown>;
  const externalId = nonEmptyString(record.accountUuid);
  if (!externalId) return null;
  const email = nonEmptyString(record.emailAddress);
  return { externalId, ...(email ? { email } : {}) };
}

export function readCodexAccountIdentity(credentialRoot: string): ProviderAccountIdentity | null {
  const auth = readJsonObject(path.join(credentialRoot, ".codex", "auth.json"));
  if (!auth) return null;
  return extractCodexIdentity(auth);
}

export function readGrokAccountIdentity(credentialRoot: string): ProviderAccountIdentity | null {
  const auth = readJsonObject(path.join(credentialRoot, ".grok", "auth.json"));
  if (!auth) return null;
  return extractXaiIdentity(auth);
}

export function readProviderAccountIdentity(
  provider: AgentId,
  credentialRoot: string,
): ProviderAccountIdentity | null {
  if (provider === "claude") return readClaudeAccountIdentity(credentialRoot);
  if (provider === "codex") return readCodexAccountIdentity(credentialRoot);
  if (provider === "grok") return readGrokAccountIdentity(credentialRoot);
  return null;
}

export interface ProviderAccountIdentityStore {
  resolveCredentialRoot(provider: AgentId, accountId: string): string;
  findByExternalId(
    serviceId: string,
    externalId: string,
    exceptAccountId?: string,
  ): CredentialRoute | undefined;
  recordAccountIdentity(
    serviceId: string,
    accountId: string,
    identity: ProviderAccountIdentity,
  ): CredentialRoute;
  refuseDuplicateConnect(
    serviceId: string,
    accountId: string,
    matched: CredentialRoute,
  ): "deleted" | "reset";
}

/** Missing identity must not block sign-in on older CLIs. */
export function refuseIfAlreadyConnected(
  provider: AgentId,
  accountId: string,
  accounts: ProviderAccountIdentityStore,
): string | null {
  const serviceId = nativeServiceForHarness(provider);
  if (!serviceId) return null;
  const root = accounts.resolveCredentialRoot(provider, accountId);
  const identity = readProviderAccountIdentity(provider, root);
  if (!identity) {
    console.warn(
      `[provider-accounts] ${provider} sign-in on ${accountId} reported no account identity; `
      + "keeping the generated label and skipping duplicate detection",
    );
    return null;
  }

  // Exclude this row so reconnecting its own account remains valid.
  const matched = accounts.findByExternalId(serviceId, identity.externalId, accountId);
  if (!matched) {
    accounts.recordAccountIdentity(serviceId, accountId, identity);
    return null;
  }

  const disposition = accounts.refuseDuplicateConnect(serviceId, accountId, matched);
  const who = identity.email ? `That account (${identity.email})` : "That account";
  const tail =
    disposition === "deleted"
      ? "The new row was removed; nothing about the existing one changed."
      : "Nothing about the existing account changed.";
  return `${who} is already connected as "${matched.label}". ${tail}`;
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}
