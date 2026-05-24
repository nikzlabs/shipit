import fs from "node:fs";
import path from "node:path";
import type { AgentId, ProviderAccount, ProviderRouteKind } from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";

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

  constructor(opts: ProviderAccountManagerOptions) {
    this.credentialsDir = opts.credentialsDir;
    this.credentialStore = opts.credentialStore;
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
