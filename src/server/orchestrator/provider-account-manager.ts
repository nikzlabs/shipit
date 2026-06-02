import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentId, ProviderAccount, ProviderRouteKind } from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";
import type { AgentAuthManager } from "./agent-auth-manager.js";

/** Persisted, non-derived account statuses (see {@link ProviderAccount}). */
export type ProviderAccountStatus = ProviderAccount["status"];

const PROVIDER_ACCOUNTS_SUBDIR = "provider-accounts";

const PROVIDER_LABEL: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

const LEGACY_CREDENTIAL_PATHS: Record<AgentId, readonly string[]> = {
  claude: [".claude", ".claude.json"],
  codex: [".codex"],
};

export interface ProviderRoute {
  kind: ProviderRouteKind;
  id: string;
}

export interface ProviderAccountManagerOptions {
  credentialsDir: string;
  credentialStore: CredentialStore;
}

/**
 * App-scoped provider-account registry for docs/150 Phase 1.
 *
 * Later phases add account-scoped auth flows, quota ranking, and failover. This
 * first slice owns the stable storage paths, default-account migration, primary
 * account selection, and coarse authConfigured predicate used by AgentRegistry.
 */
export class ProviderAccountManager {
  private credentialsDir: string;
  private credentialStore: CredentialStore;
  /**
   * Per-provider auth managers, attached after construction (the managers are
   * built in `app-di`/`buildAgentRuntime`, after this manager). Used to drive
   * account-scoped login/cancel/sign-out flows. `null` until attached — the
   * scoped-auth methods throw a clear error if invoked before wiring.
   */
  private authManagers: Map<AgentId, AgentAuthManager> | null = null;

  constructor(opts: ProviderAccountManagerOptions) {
    this.credentialsDir = opts.credentialsDir;
    this.credentialStore = opts.credentialStore;
  }

  /**
   * Wire the per-provider auth managers so this manager can start/cancel
   * account-scoped login flows (docs/150). Called once from `index.ts` after
   * `buildAgentRuntime`.
   */
  attachAuthManagers(authManagers: Map<AgentId, AgentAuthManager>): void {
    this.authManagers = authManagers;
  }

  migrateDefaultAccounts(): void {
    this.migrateProviderDefault("claude", "claude-default", "Primary Anthropic account");
    this.migrateProviderDefault("codex", "codex-default", "Primary ChatGPT account");
  }

  list(provider?: AgentId): ProviderAccount[] {
    return this.credentialStore.listProviderAccounts(provider);
  }

  get(provider: AgentId, accountId: string): ProviderAccount | undefined {
    return this.credentialStore.getProviderAccount(provider, accountId);
  }

  getPrimary(provider: AgentId): ProviderAccount | undefined {
    return this.credentialStore.getPrimaryProviderAccount(provider);
  }

  create(provider: AgentId, label?: string): ProviderAccount {
    const now = Date.now();
    const existing = this.list(provider);
    const account: ProviderAccount = {
      id: `acct_${randomUUID()}`,
      provider,
      label: normalizeLabel(label) ?? `${PROVIDER_LABEL[provider]} account ${existing.length + 1}`,
      isPrimary: existing.length === 0,
      status: "unavailable",
      capabilities: {
        source: "manual_default",
        refreshedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    fs.mkdirSync(this.resolveCredentialRoot(provider, account.id), { recursive: true });
    this.credentialStore.upsertProviderAccount(account);
    return this.get(provider, account.id) ?? account;
  }

  rename(provider: AgentId, accountId: string, label: string): ProviderAccount {
    const account = this.require(provider, accountId);
    const normalized = normalizeLabel(label);
    if (!normalized) throw new Error("Provider account label cannot be empty");
    if (normalized.length > 120) throw new Error("Provider account label is too long (max 120 characters)");
    this.credentialStore.upsertProviderAccount({ ...account, label: normalized });
    return this.require(provider, accountId);
  }

  makePrimary(provider: AgentId, accountId: string): ProviderAccount {
    const account = this.require(provider, accountId);
    this.credentialStore.upsertProviderAccount({ ...account, isPrimary: true });
    return this.require(provider, accountId);
  }

  delete(provider: AgentId, accountId: string): void {
    this.require(provider, accountId);
    fs.rmSync(this.resolveCredentialRoot(provider, accountId), { recursive: true, force: true });
    this.credentialStore.deleteProviderAccount(provider, accountId);
  }

  require(provider: AgentId, accountId: string): ProviderAccount {
    const account = this.get(provider, accountId);
    if (!account) throw new Error(`Provider account not found: ${provider}/${accountId}`);
    return account;
  }

  selectRouteForTurn(provider: AgentId): ProviderRoute | null {
    const account = this.getPrimary(provider);
    if (account?.status === "ready" || account?.status === "authenticating") {
      return { kind: "account", id: account.id };
    }

    if (provider === "claude") {
      if (process.env.ANTHROPIC_AUTH_TOKEN?.trim()) return { kind: "reserved", id: "claude-env-oauth" };
      if (process.env.ANTHROPIC_API_KEY?.trim()) return { kind: "reserved", id: "claude-api-key" };
    }
    if (provider === "codex" && process.env.OPENAI_API_KEY?.trim()) {
      return { kind: "reserved", id: "codex-api-key" };
    }
    return null;
  }

  hasAnyAuthForProvider(provider: AgentId): boolean {
    if (this.list(provider).length > 0) return true;
    if (provider === "claude") {
      return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
    }
    return Boolean(process.env.OPENAI_API_KEY?.trim());
  }

  resolveCredentialRoot(provider: AgentId, accountId: string): string {
    return path.join(this.credentialsDir, PROVIDER_ACCOUNTS_SUBDIR, provider, accountId);
  }

  /** Overwrite the persisted status of an account (idempotent). */
  setAccountStatus(provider: AgentId, accountId: string, status: ProviderAccountStatus): ProviderAccount {
    const account = this.require(provider, accountId);
    if (account.status === status) return account;
    this.credentialStore.upsertProviderAccount({ ...account, status });
    return this.require(provider, accountId);
  }

  // ---- Account-scoped auth flows (docs/150) ----

  /**
   * Start the provider's login flow scoped to a specific account row. The
   * provider CLI is spawned with `HOME` pointed at the account's credential
   * root, so it writes into `provider-accounts/<provider>/acct_<id>/...`
   * instead of the singleton path. Marks the row `authenticating`; the
   * eventual `complete`/`failed` event (handled in `app-lifecycle`) flips it
   * to `ready`/`auth_failed`.
   */
  startAccountAuth(provider: AgentId, accountId: string): ProviderAccount {
    this.require(provider, accountId);
    const mgr = this.requireAuthManager(provider);
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    fs.mkdirSync(credentialDir, { recursive: true });
    const account = this.setAccountStatus(provider, accountId, "authenticating");
    mgr.start({ accountId, credentialDir });
    return account;
  }

  /**
   * Cancel an in-flight scoped login. Resets the row's status to `ready` when
   * the account already has on-disk credentials, otherwise `unavailable`.
   */
  cancelAccountAuth(provider: AgentId, accountId: string): ProviderAccount {
    this.require(provider, accountId);
    const mgr = this.requireAuthManager(provider);
    mgr.cancel();
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    const status: ProviderAccountStatus = mgr.isConfigured({ credentialDir }) ? "ready" : "unavailable";
    return this.setAccountStatus(provider, accountId, status);
  }

  /**
   * Submit a verification code into an in-flight scoped Claude login. No-op
   * for providers whose flow has no paste-code step (Codex device-auth).
   */
  submitAccountCode(provider: AgentId, accountId: string, code: string): void {
    this.require(provider, accountId);
    const mgr = this.requireAuthManager(provider);
    if (typeof mgr.submitCode !== "function") {
      throw new Error(`${PROVIDER_LABEL[provider]} login has no code-submission step`);
    }
    mgr.submitCode(code);
  }

  /**
   * Remove a single account's on-disk credentials (scoped sign-out). Leaves
   * the account row itself in place; callers decide whether to also delete
   * the row. Marks the row `unavailable`.
   */
  signOutAccount(provider: AgentId, accountId: string): ProviderAccount {
    this.require(provider, accountId);
    const mgr = this.requireAuthManager(provider);
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    mgr.signOut({ credentialDir });
    return this.setAccountStatus(provider, accountId, "unavailable");
  }

  private requireAuthManager(provider: AgentId): AgentAuthManager {
    const mgr = this.authManagers?.get(provider);
    if (!mgr) throw new Error(`No auth manager wired for provider: ${provider}`);
    return mgr;
  }

  private migrateProviderDefault(provider: AgentId, accountId: string, label: string): void {
    if (this.list(provider).length > 0) return;

    const existingRelPaths = LEGACY_CREDENTIAL_PATHS[provider].filter((rel) =>
      fs.existsSync(path.join(this.credentialsDir, rel)),
    );
    if (existingRelPaths.length === 0) return;

    const accountRoot = this.resolveCredentialRoot(provider, accountId);
    fs.mkdirSync(accountRoot, { recursive: true });

    for (const rel of existingRelPaths) {
      const legacy = path.join(this.credentialsDir, rel);
      const dest = path.join(accountRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) {
        try {
          fs.renameSync(legacy, dest);
        } catch {
          fs.cpSync(legacy, dest, { recursive: true, force: true });
          fs.rmSync(legacy, { recursive: true, force: true });
        }
      } else {
        fs.rmSync(legacy, { recursive: true, force: true });
      }
      this.ensureLegacyAlias(legacy, dest);
    }

    const now = Date.now();
    this.credentialStore.upsertProviderAccount({
      id: accountId,
      provider,
      label,
      isPrimary: true,
      status: "ready",
      capabilities: {
        source: "manual_default",
        refreshedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  private ensureLegacyAlias(legacyPath: string, targetPath: string): void {
    try {
      if (fs.existsSync(legacyPath)) return;
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.symlinkSync(targetPath, legacyPath);
    } catch (err) {
      console.warn("[provider-accounts] failed to create legacy credential alias:", err);
    }
  }
}

export function providerAccountCredentialRoot(
  credentialsDir: string,
  provider: AgentId,
  accountId: string,
): string {
  return path.join(credentialsDir, PROVIDER_ACCOUNTS_SUBDIR, provider, accountId);
}

export function legacyCredentialPathsForProvider(provider: AgentId): readonly string[] {
  return LEGACY_CREDENTIAL_PATHS[provider];
}

export function providerDisplayLabel(provider: AgentId): string {
  return PROVIDER_LABEL[provider];
}

function normalizeLabel(label: string | undefined): string | null {
  const normalized = typeof label === "string" ? label.trim() : "";
  return normalized || null;
}
