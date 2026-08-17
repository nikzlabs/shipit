/**
 * docs/150-multiple-provider-subscriptions req 22 — the provider's own identity for a connected account.
 *
 * ShipIt's account rows are user-facing labels over a credential directory, and
 * until now that was *all* they were: two rows could hold credentials for the
 * same upstream subscription and nothing would notice. That is not a cosmetic
 * duplicate — two rows sharing one quota pool make failover between them a
 * no-op that burns req 14's single retry and reports a confusing error.
 *
 * So a connect reads the identity the provider itself reports, out of the
 * credentials the CLI just wrote into that account's root:
 *
 *   - **Claude** — `<root>/.claude.json` → `oauthAccount.{accountUuid,emailAddress}`.
 *     Deliberately NOT `.claude/.credentials.json`: that file carries only
 *     `subscriptionType` and `rateLimitTier`, which is *plan* data, so two
 *     different accounts on the same plan are indistinguishable by it.
 *   - **Codex** — `<root>/.codex/auth.json` → the `chatgpt_account_id` claim,
 *     which the auth manager already decoded for the plan label but never kept.
 *
 * `externalId` is the stable key (`accountUuid` rather than the email, because
 * an email can change under the same account). `email` is the label default
 * only.
 *
 * Every reader here is best-effort and returns null rather than throwing: an
 * older CLI, an env-only route, or a hand-edited config must degrade a connect
 * to today's behaviour (generated label, no duplicate detection), never fail
 * it. Identity is an improvement on top of a working connect, not a
 * precondition for one.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentId, CredentialRoute } from "../shared/types.js";
import { nativeServiceForHarness } from "../shared/catalogue/index.js";
import { extractCodexIdentity } from "./agents/codex/auth-manager.js";

export interface ProviderAccountIdentity {
  /** The provider's stable id for this account. Used for duplicate detection. */
  externalId: string;
  /** The email the provider reports, when it reports one. Label default only. */
  email?: string;
}

/** Read `<credentialRoot>/.claude.json`'s `oauthAccount`. */
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

/** Read `<credentialRoot>/.codex/auth.json`'s ChatGPT account claim. */
export function readCodexAccountIdentity(credentialRoot: string): ProviderAccountIdentity | null {
  const auth = readJsonObject(path.join(credentialRoot, ".codex", "auth.json"));
  if (!auth) return null;
  return extractCodexIdentity(auth);
}

/** Identity for whichever provider owns this credential root, or null. */
export function readProviderAccountIdentity(
  provider: AgentId,
  credentialRoot: string,
): ProviderAccountIdentity | null {
  if (provider === "claude") return readClaudeAccountIdentity(credentialRoot);
  if (provider === "codex") return readCodexAccountIdentity(credentialRoot);
  // OpenCode has no provider accounts at launch (docs/268 req 5 — key-mode
  // services only), so there is no auth.json identity to extract yet. A future
  // login integration adds a reader here.
  return null;
}

/**
 * The slice of `ProviderAccountManager` the connect-time policy below needs.
 *
 * Structural rather than the class itself so this module stays free of the
 * manager (which would be a cycle the moment the manager wants to read an
 * identity) and so the policy is testable without a credential store on disk.
 */
export interface ProviderAccountIdentityStore {
  /** Harness-keyed: the on-disk credential root (`provider-accounts/<harness>/…`). */
  resolveCredentialRoot(provider: AgentId, accountId: string): string;
  /** Service-keyed, like every other credential-row verb (planning#342). */
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

/**
 * docs/150-multiple-provider-subscriptions req 22 — apply the identity a just-completed sign-in reported.
 *
 * Returns `null` when the connect may proceed (having recorded the identity and
 * possibly adopted the reported email as the label), or the message to show the
 * user when it was refused as a duplicate.
 *
 * An unreadable identity proceeds. That is deliberate rather than fail-safe
 * paranoia: refusing every connect ShipIt cannot identify would make an older
 * CLI, or a provider that stops reporting the field, unable to connect an
 * account at all — trading a rare confusing duplicate for a total outage.
 */
export function refuseIfAlreadyConnected(
  provider: AgentId,
  accountId: string,
  accounts: ProviderAccountIdentityStore,
): string | null {
  // The sign-in event names a harness; the row verbs are keyed by service
  // (planning#342). A harness with no catalogue vendor has no account rows to
  // collide with, so there is nothing to refuse.
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

  // `accountId` is excluded so a row signing back into its own account — the
  // repair path for a stale or revoked row — is not refused as a duplicate of
  // itself.
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
