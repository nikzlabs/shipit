import type { LoginIntegrationId } from "../shared/catalogue/types.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AccountSelectionMode,
  AgentId,
  CredentialRoute,
  CredentialStatus,
  FailoverCutoffs,
  ProviderRouteKind,
  SubscriptionLimits,
  SubscriptionLimitsMap,
} from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";
import type { AgentAuthManager } from "./agent-auth-manager.js";
import {
  allServices,
  harnessForNativeService,
  modeCredentialFor,
  loginIntegrationForService,
  nativeServiceForHarness,
} from "../shared/catalogue/index.js";
import { credentialModeKey, orderCredentialRoutes, refusalBlockedUntil } from "../shared/types/domain-types/credential-route.js";
import { subscriptionWindowIsCurrent } from "../shared/types/usage-limits-types.js";
import { probeNestedString } from "./agents/agent-auth-base.js";

const ACCOUNT_BILLING_MODE = "sub" as const;

export const PROVIDER_ACCOUNTS_SUBDIR = "provider-accounts";

const PROVIDER_LABEL: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok Build",
};

const LEGACY_CREDENTIAL_PATHS: Record<AgentId, readonly LegacyCredentialPath[]> = {
  claude: [{ rel: ".claude", kind: "dir" }, { rel: ".claude.json", kind: "file" }],
  codex: [{ rel: ".codex", kind: "dir" }],
  opencode: [],
  grok: [],
};

interface LegacyCredentialPath {
  rel: string;
  kind: "dir" | "file";
}

// Config files and empty placeholder directories are not evidence of an account.
const LEGACY_CREDENTIAL_MARKERS: Record<AgentId, readonly string[]> = {
  claude: [
    path.join(".claude", ".credentials.json"),
    path.join(".claude", "credentials.json"),
    path.join(".claude", "auth.json"),
  ],
  codex: [path.join(".codex", "auth.json")],
  opencode: [],
  grok: [],
};

export interface ProviderRoute {
  kind: ProviderRouteKind;
  id: string;
}

// IDs are persisted on sessions. Anthropic's subscription token precedes its metered key.
const RESERVED_ENV_ROUTES: Record<string, readonly { env: string; id: string }[]> = {
  anthropic: [
    { env: "ANTHROPIC_AUTH_TOKEN", id: "claude-env-oauth" },
    { env: "ANTHROPIC_API_KEY", id: "claude-api-key" },
  ],
  openai: [{ env: "OPENAI_API_KEY", id: "codex-api-key" }],
};

function routingSettingsKeyFor(serviceId: string): [string, typeof ACCOUNT_BILLING_MODE] {
  return [serviceId, ACCOUNT_BILLING_MODE];
}

function accountServiceIds(): string[] {
  return allServices()
    .filter((service) => modeCredentialFor(service.id, ACCOUNT_BILLING_MODE, "account") !== undefined)
    .map((service) => service.id);
}

// On-disk homes remain harness-keyed; routing settings are keyed by service and billing mode.
function harnessFor(serviceId: string): AgentId | undefined {
  return harnessForNativeService(serviceId);
}

function requireHarness(serviceId: string): AgentId {
  const harness = harnessFor(serviceId);
  if (!harness) throw new Error(`No account-backed harness for service: ${serviceId}`);
  return harness;
}

// OpenCode consumes the existing OpenAI login; Zen remains its native service.
export function accountOwnerHarness(provider: AgentId): AgentId {
  return provider === "opencode" ? "codex" : provider;
}

export function accountServiceForHarness(provider: AgentId): string {
  return nativeServiceForHarness(accountOwnerHarness(provider)) ?? "";
}

export interface ProviderAccountManagerOptions {
  credentialsDir: string;
  credentialStore: CredentialStore;
  getSubscriptionLimits?: () => SubscriptionLimitsMap;
}

export type AccountSelectionFailure =
  | { reason: "auth_required" }
  | { reason: "all_exhausted"; earliestResetAt: string | null };

export type AccountSelection =
  | { ok: true; route: ProviderRoute }
  | ({ ok: false } & AccountSelectionFailure);

export interface SelectAccountOptions {
  exclude?: readonly string[];
  // Balanced mode keeps a healthy resident route to avoid respawning on every turn.
  residentRouteId?: string;
  // Only callers that will attempt the route may retry refusal-blocked accounts.
  optimistic?: boolean;
}

export class ProviderAccountManager {
  private credentialsDir: string;
  private credentialStore: CredentialStore;
  private authManagers: Map<LoginIntegrationId, AgentAuthManager> | null = null;
  private getSubscriptionLimits: (() => SubscriptionLimitsMap) | undefined;

  constructor(opts: ProviderAccountManagerOptions) {
    this.credentialsDir = opts.credentialsDir;
    this.credentialStore = opts.credentialStore;
    this.getSubscriptionLimits = opts.getSubscriptionLimits;
  }

  subscriptionLimitsFor(
    serviceId: string,
    billingMode: "sub" | "key",
  ): Record<string, SubscriptionLimits> {
    return this.getSubscriptionLimits?.()?.[credentialModeKey(serviceId, billingMode)] ?? {};
  }

  attachSubscriptionLimits(getSubscriptionLimits: () => SubscriptionLimitsMap): void {
    this.getSubscriptionLimits = getSubscriptionLimits;
  }

  attachAuthManagers(authManagers: Map<LoginIntegrationId, AgentAuthManager>): void {
    this.authManagers = authManagers;
  }

  migrateDefaultAccounts(): void {
    this.migrateProviderDefault("claude", "claude-default", "Primary Anthropic account");
    this.migrateProviderDefault("codex", "codex-default", "Primary ChatGPT account");
    this.backfillPriority();
    this.removeLegacyAliases();
  }

  // A duplicated bearer has no provable owner. Require every affected row to reconnect.
  quarantineDuplicateClaudeCredentials(): string[][] {
    const byToken = new Map<string, string[]>();
    for (const account of this.list("anthropic")) {
      const root = this.resolveCredentialRoot("claude", account.id);
      const token = LEGACY_CREDENTIAL_MARKERS.claude
        .map((rel) => readClaudeAccessToken(path.join(root, rel)))
        .find((candidate): candidate is string => candidate !== null);
      if (!token) continue;
      const ids = byToken.get(token) ?? [];
      ids.push(account.id);
      byToken.set(token, ids);
    }

    const duplicates = [...byToken.values()].filter((ids) => ids.length > 1);
    for (const ids of duplicates) {
      for (const id of ids) this.setAccountStatus("anthropic", id, "auth_failed");
    }
    return duplicates;
  }

  // Empty directories keep image-level symlinks usable without exposing a default account.
  private removeLegacyAliases(): void {
    const accountsPrefix = path.join(this.credentialsDir, PROVIDER_ACCOUNTS_SUBDIR);
    for (const provider of ["claude", "codex"] as AgentId[]) {
      const serviceId = nativeServiceForHarness(provider);
      const migrated = serviceId !== undefined && this.list(serviceId).length > 0;
      for (const { rel, kind } of LEGACY_CREDENTIAL_PATHS[provider]) {
        const aliasPath = path.join(this.credentialsDir, rel);
        try {
          const stat = fs.lstatSync(aliasPath, { throwIfNoEntry: false });
          if (stat?.isSymbolicLink()) {
            const target = path.resolve(path.dirname(aliasPath), fs.readlinkSync(aliasPath));
            const insideAccounts =
              target === accountsPrefix || target.startsWith(`${accountsPrefix}${path.sep}`);
            if (!insideAccounts) continue;
            fs.unlinkSync(aliasPath);
          } else if (stat) {
            // Real paths may hold the only pre-migration credentials.
            continue;
          }
          if (kind === "dir" && migrated) fs.mkdirSync(aliasPath, { recursive: true });
        } catch (err) {
          console.warn(`[provider-accounts] failed to retire legacy alias ${aliasPath}:`, err);
        }
      }
    }
  }

  // Call with a catalogue service ID: list("claude") compiles but matches no service.
  list(serviceId?: string): CredentialRoute[] {
    if (serviceId === undefined) {
      return accountServiceIds().flatMap((id) => this.list(id));
    }
    return orderCredentialRoutes(
      this.credentialStore
        .listCredentialRoutes(serviceId, ACCOUNT_BILLING_MODE)
        .filter((route) => route.via === "account"),
    );
  }

  get(serviceId: string, routeId: string): CredentialRoute | undefined {
    return this.list(serviceId).find((route) => route.id === routeId);
  }

  getPrimary(serviceId: string): CredentialRoute | undefined {
    return this.list(serviceId)[0];
  }

  backfillPriority(): void {
    for (const serviceId of accountServiceIds()) {
      const stored = this.credentialStore
        .listCredentialRoutes(serviceId, ACCOUNT_BILLING_MODE)
        .filter((route) => route.via === "account");
      if (stored.length === 0 || stored.every((a) => typeof a.priority === "number")) continue;
      // Preserve the legacy order when assigning explicit priorities.
      const primaryId = stored.find((a) => a.isPrimary)?.id ?? stored[0]?.id;
      const ordered = stored
        .map((route, index) => ({ route, index }))
        .sort((a, b) => legacyRank(a, primaryId) - legacyRank(b, primaryId) || a.index - b.index)
        .map((entry) => entry.route);
      ordered.forEach((route, index) => {
        this.credentialStore.upsertCredentialRoute({ ...route, priority: index });
      });
    }
  }

  accountsInSelectionOrder(serviceId: string): CredentialRoute[] {
    return this.list(serviceId);
  }

  // Require the complete set so stale clients cannot silently reorder around missing accounts.
  reorder(serviceId: string, orderedIds: readonly string[]): CredentialRoute[] {
    const accounts = this.list(serviceId);
    const known = new Set(accounts.map((account) => account.id));
    const requested = new Set(orderedIds);
    if (requested.size !== orderedIds.length) {
      throw new Error("Provider account order contains duplicates");
    }
    if (requested.size !== known.size || orderedIds.some((id) => !known.has(id))) {
      throw new Error("Provider account order must list every account for this provider exactly once");
    }
    orderedIds.forEach((id, index) => {
      const account = accounts.find((a) => a.id === id)!;
      this.credentialStore.upsertCredentialRoute({ ...account, priority: index });
    });
    return this.accountsInSelectionOrder(serviceId);
  }

  create(serviceId: string, label?: string): CredentialRoute {
    const provider = requireHarness(serviceId);
    const now = Date.now();
    const existing = this.list(serviceId);
    const supplied = normalizeLabel(label);
    const account: CredentialRoute = {
      id: `acct_${randomUUID()}`,
      serviceId,
      billingMode: ACCOUNT_BILLING_MODE,
      via: "account",
      label: supplied ?? generatedAccountLabel(provider, existing),
      labelIsGenerated: supplied === null,
      isPrimary: false,
      priority: existing.reduce((max, a) => Math.max(max, a.priority ?? -1), -1) + 1,
      status: "unavailable",
      capabilities: {
        source: "manual_default",
        refreshedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    fs.mkdirSync(this.resolveCredentialRoot(provider, account.id), { recursive: true });
    this.credentialStore.upsertCredentialRoute(account);
    return this.get(serviceId, account.id) ?? account;
  }

  rename(serviceId: string, accountId: string, label: string): CredentialRoute {
    const account = this.require(serviceId, accountId);
    const normalized = normalizeLabel(label);
    if (!normalized) throw new Error("Provider account label cannot be empty");
    if (normalized.length > 120) throw new Error("Provider account label is too long (max 120 characters)");
    this.credentialStore.upsertCredentialRoute({
      ...account,
      label: normalized,
      labelIsGenerated: false,
    });
    return this.require(serviceId, accountId);
  }

  findByExternalId(
    serviceId: string,
    externalId: string,
    exceptAccountId?: string,
  ): CredentialRoute | undefined {
    return this.list(serviceId).find(
      (account) => account.externalId === externalId && account.id !== exceptAccountId,
    );
  }

  recordAccountIdentity(
    serviceId: string,
    accountId: string,
    identity: { externalId: string; email?: string },
  ): CredentialRoute {
    const account = this.require(serviceId, accountId);
    const adoptLabel = account.labelIsGenerated === true && identity.email !== undefined;
    this.credentialStore.upsertCredentialRoute({
      ...account,
      externalId: identity.externalId,
      ...(adoptLabel ? { label: identity.email! } : {}),
    });
    return this.require(serviceId, accountId);
  }

  // Keep an established row's identity and preferences; remove a never-connected duplicate row.
  refuseDuplicateConnect(
    serviceId: string,
    accountId: string,
    matched: CredentialRoute,
  ): "deleted" | "reset" {
    const provider = requireHarness(serviceId);
    const account = this.require(serviceId, accountId);
    console.warn(
      `[provider-accounts] refusing ${provider} sign-in on ${accountId}: `
      + `already connected as "${matched.label}" (${matched.id})`,
    );
    if (account.externalId === undefined) {
      this.delete(serviceId, accountId);
      return "deleted";
    }
    fs.rmSync(this.resolveCredentialRoot(provider, accountId), { recursive: true, force: true });
    fs.mkdirSync(this.resolveCredentialRoot(provider, accountId), { recursive: true });
    this.setAccountStatus(serviceId, accountId, "auth_failed");
    return "reset";
  }

  // Stamp actual selections, not probes. Monotonic stamps separate same-millisecond bursts.
  markAccountUsed(serviceId: string, accountId: string): void {
    const account = this.get(serviceId, accountId);
    if (!account) return;
    const peak = this.list(serviceId).reduce((max, a) => Math.max(max, a.lastUsedAt ?? 0), 0);
    this.credentialStore.upsertCredentialRoute({
      ...account,
      lastUsedAt: Math.max(Date.now(), peak + 1),
    });
  }

  delete(serviceId: string, accountId: string): void {
    const provider = requireHarness(serviceId);
    this.require(serviceId, accountId);
    // Cancel the deleted row's login or its active scope would block later sign-ins.
    const loginId = loginIntegrationForService(serviceId);
    const mgr = loginId ? this.authManagers?.get(loginId) : undefined;
    if (mgr?.getActiveAccountId() === accountId) mgr.cancel();
    fs.rmSync(this.resolveCredentialRoot(provider, accountId), { recursive: true, force: true });
    this.credentialStore.deleteCredentialRoute(accountId);
  }

  require(serviceId: string, accountId: string): CredentialRoute {
    const account = this.get(serviceId, accountId);
    if (!account) throw new Error(`Provider account not found: ${serviceId}/${accountId}`);
    return account;
  }

  selectRouteForTurn(serviceId: string): ProviderRoute | null {
    const selection = this.selectAccountForTurn(serviceId);
    return selection.ok ? selection.route : null;
  }

  // Legacy callers without a selected billing mode can still use env/API-key fallbacks.
  private reservedRouteFor(serviceId: string): ProviderRoute | null {
    for (const candidate of RESERVED_ENV_ROUTES[serviceId] ?? []) {
      if (process.env[candidate.env]?.trim()) return { kind: "reserved", id: candidate.id };
    }
    return null;
  }

  selectAccountForTurn(serviceId: string, opts: SelectAccountOptions = {}): AccountSelection {
    const exclude = new Set(opts.exclude ?? []);
    const mode = this.credentialStore.getSelectionMode(...routingSettingsKeyFor(serviceId));
    const eligible = this.accountsInSelectionOrder(serviceId).filter(
      (account) => account.status === "ready" || account.status === "authenticating",
    );
    const connected = orderForSelectionMode(
      eligible.filter((account) => !exclude.has(account.id)),
      mode,
    );

    const limits = this.subscriptionLimitsFor(...routingSettingsKeyFor(serviceId));
    const now = Date.now();
    const cutoffs = this.credentialStore.getFailoverCutoffs(...routingSettingsKeyFor(serviceId));

    // Telemetry changes priority; only a recorded refusal blocks an attempt.
    const clear: CredentialRoute[] = [];
    const overCutoff: CredentialRoute[] = [];
    const looksSpent: CredentialRoute[] = [];
    const blocked: CredentialRoute[] = [];
    const blockedResets: number[] = [];
    for (let account of connected) {
      if (
        refusalBlockedUntil(account, now) !== null
        && this.clearRefusalOnHealthyReading(serviceId, account.id, limits[account.id])
      ) {
        account = this.get(serviceId, account.id) ?? account;
      }
      const blockedUntil = refusalBlockedUntil(account, now);
      if (blockedUntil !== null) {
        blocked.push(account);
        blockedResets.push(blockedUntil);
        continue;
      }
      if (snapshotExhaustedResetAt(limits[account.id], now) !== null) {
        looksSpent.push(account);
        continue;
      }
      if (isOverCutoff(limits[account.id], cutoffs, now)) {
        overCutoff.push(account);
        continue;
      }
      clear.push(account);
    }

    if (mode === "balanced" && opts.residentRouteId) {
      const resident = clear.find((account) => account.id === opts.residentRouteId);
      if (resident) return { ok: true, route: { kind: "account", id: resident.id } };
    }

    const pick = clear[0] ?? overCutoff[0] ?? looksSpent[0];
    if (pick) return { ok: true, route: { kind: "account", id: pick.id } };

    // Refused or excluded subscriptions must not fall through to metered billing.
    if (blocked.length > 0 || eligible.length > connected.length) {
      const probe = blocked[0];
      if (opts.optimistic && probe) return { ok: true, route: { kind: "account", id: probe.id } };
      const earliest = Math.min(...blockedResets);
      return {
        ok: false,
        reason: "all_exhausted",
        earliestResetAt: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null,
      };
    }
    const reserved = this.reservedRouteFor(serviceId);
    if (reserved && !exclude.has(reserved.id)) return { ok: true, route: reserved };
    return { ok: false, reason: "auth_required" };
  }

  hasAnyAuthForProvider(provider: AgentId): boolean {
    const serviceId = nativeServiceForHarness(provider);
    if (serviceId && this.list(serviceId).some((account) => account.status === "ready")) return true;
    return (RESERVED_ENV_ROUTES[serviceId ?? ""] ?? []).some(
      (candidate) => Boolean(process.env[candidate.env]?.trim()),
    );
  }

  getByRouteId(routeId: string): CredentialRoute | undefined {
    for (const serviceId of accountServiceIds()) {
      const account = this.get(serviceId, routeId);
      if (account) return account;
    }
    return undefined;
  }

  resolveCredentialRoot(provider: AgentId, accountId: string): string {
    return providerAccountCredentialRoot(this.credentialsDir, provider, accountId);
  }

  // The latest refusal supersedes older estimates and re-arms the bounded re-probe window.
  markAccountExhausted(serviceId: string, accountId: string, until: number): CredentialRoute | null {
    const account = this.get(serviceId, accountId);
    if (!account) return null;
    this.credentialStore.upsertCredentialRoute({
      ...account,
      exhaustedUntil: until,
      exhaustedAt: Date.now(),
    });
    return this.get(serviceId, accountId) ?? null;
  }

  clearAccountExhaustion(serviceId: string, accountId: string): CredentialRoute {
    const account = this.require(serviceId, accountId);
    if (account.exhaustedUntil === null || account.exhaustedUntil === undefined) return account;
    this.credentialStore.upsertCredentialRoute({ ...account, exhaustedUntil: null, exhaustedAt: null });
    return this.require(serviceId, accountId);
  }

  clearRefusalOnHealthyReading(
    serviceId: string,
    accountId: string,
    snapshot: { session?: unknown; weekly?: unknown; fetchedAt?: unknown } | undefined,
  ): boolean {
    const account = this.get(serviceId, accountId);
    if (!account) return false;
    if (account.exhaustedUntil === null || account.exhaustedUntil === undefined) return false;
    if (!snapshot || typeof snapshot.fetchedAt !== "number" || !Number.isFinite(snapshot.fetchedAt)) return false;
    const observedAt = typeof account.exhaustedAt === "number" ? account.exhaustedAt : 0;
    if (snapshot.fetchedAt <= observedAt) return false;
    const now = Date.now();
    for (const key of ["session", "weekly"] as const) {
      const window = snapshot[key] as { usedPct?: unknown; resetAt?: unknown } | null | undefined;
      // A fresh snapshot can retain an expired window; it must not prolong a refusal.
      if (!subscriptionWindowIsCurrent(window, now)) continue;
      if (typeof window?.usedPct === "number" && window.usedPct >= 100) return false;
    }
    this.credentialStore.upsertCredentialRoute({ ...account, exhaustedUntil: null, exhaustedAt: null });
    return true;
  }

  setAccountStatus(serviceId: string, accountId: string, status: CredentialStatus): CredentialRoute {
    const account = this.require(serviceId, accountId);
    if (account.status === status) return account;
    this.credentialStore.upsertCredentialRoute({ ...account, status });
    return this.require(serviceId, accountId);
  }

  startAccountAuth(serviceId: string, accountId: string): CredentialRoute {
    const provider = requireHarness(serviceId);
    this.require(serviceId, accountId);
    const mgr = this.requireAuthManager(serviceId);
    // One login process serves all rows for this integration.
    const inFlight = mgr.getActiveAccountId();
    if (inFlight && inFlight !== accountId) {
      const label = this.get(serviceId, inFlight)?.label ?? inFlight;
      throw new Error(
        `${PROVIDER_LABEL[provider]} is already signing in on "${label}". Finish or cancel that sign-in first.`,
      );
    }
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    fs.mkdirSync(credentialDir, { recursive: true });
    const account = this.setAccountStatus(serviceId, accountId, "authenticating");
    try {
      mgr.start({ accountId, credentialDir });
    } catch (err) {
      this.setAccountStatus(serviceId, accountId, "unavailable");
      try { mgr.cancel(); } catch { /* The flow may never have started. */ }
      throw err;
    }
    return account;
  }

  cancelAccountAuth(serviceId: string, accountId: string): CredentialRoute {
    const provider = requireHarness(serviceId);
    this.require(serviceId, accountId);
    const mgr = this.requireAuthManager(serviceId);
    const inFlight = mgr.getActiveAccountId();
    if (!inFlight || inFlight === accountId) mgr.cancel();
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    const status: CredentialStatus = mgr.isConfigured({ credentialDir }) ? "ready" : "unavailable";
    return this.setAccountStatus(serviceId, accountId, status);
  }

  submitAccountCode(serviceId: string, accountId: string, code: string): void {
    const provider = requireHarness(serviceId);
    this.require(serviceId, accountId);
    const mgr = this.requireAuthManager(serviceId);
    if (typeof mgr.submitCode !== "function") {
      throw new Error(`${PROVIDER_LABEL[provider]} login has no code-submission step`);
    }
    // Codes belong to a specific challenge; a missing flow must also be refused.
    const inFlight = mgr.getActiveAccountId();
    if (inFlight !== accountId) {
      const label = inFlight ? this.get(serviceId, inFlight)?.label ?? inFlight : null;
      throw new Error(
        label
          ? `${PROVIDER_LABEL[provider]} is already signing in on "${label}". Finish or cancel that sign-in first.`
          : `That ${PROVIDER_LABEL[provider]} sign-in is no longer running. Start it again before pasting the code.`,
      );
    }
    mgr.submitCode(code);
  }

  signOutAccount(serviceId: string, accountId: string): CredentialRoute {
    const provider = requireHarness(serviceId);
    this.require(serviceId, accountId);
    const mgr = this.requireAuthManager(serviceId);
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    mgr.signOut({ credentialDir });
    return this.setAccountStatus(serviceId, accountId, "unavailable");
  }

  // Source credentials only. Call services/settings.signOutProvider to revoke session copies too.
  signOutProvider(provider: AgentId): void {
    const serviceId = nativeServiceForHarness(provider);
    for (const account of serviceId ? this.list(serviceId) : []) {
      this.delete(serviceId!, account.id);
    }
    if (serviceId) this.requireAuthManager(serviceId).signOut();
  }

  private requireAuthManager(serviceId: string): AgentAuthManager {
    const loginId = loginIntegrationForService(serviceId);
    const mgr = loginId ? this.authManagers?.get(loginId) : undefined;
    if (!mgr) throw new Error(`No auth manager wired for service: ${serviceId}`);
    return mgr;
  }

  private migrateProviderDefault(provider: AgentId, accountId: string, label: string): void {
    const serviceId = nativeServiceForHarness(provider);
    if (!serviceId) return;
    if (this.list(serviceId).length > 0) return;

    // /credentials inside a session is its live agent home, not the orchestrator volume.
    if (isSessionContainerCredentialRoot()) {
      console.warn(
        `[provider-accounts] skipping ${provider} legacy migration: running inside session `
          + `container ${process.env.SHIPIT_SESSION_ID}, where ${this.credentialsDir} is the `
          + `live agent home, not the orchestrator credentials volume.`,
      );
      return;
    }

    const hasCredentials = LEGACY_CREDENTIAL_MARKERS[provider].some((rel) =>
      isNonEmptyFile(path.join(this.credentialsDir, rel)),
    );
    if (!hasCredentials) return;

    const existingRelPaths = LEGACY_CREDENTIAL_PATHS[provider].filter((entry) =>
      fs.existsSync(path.join(this.credentialsDir, entry.rel)),
    );
    if (existingRelPaths.length === 0) return;

    const accountRoot = this.resolveCredentialRoot(provider, accountId);
    fs.mkdirSync(accountRoot, { recursive: true });

    // Copy before removing the source; a failed copy must leave credentials available.
    for (const { rel } of existingRelPaths) {
      const legacy = path.join(this.credentialsDir, rel);
      const dest = path.join(accountRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) {
        try {
          fs.cpSync(legacy, dest, { recursive: true, force: true, dereference: true });
        } catch (err) {
          console.error(
            `[provider-accounts] ${provider} legacy migration failed copying ${legacy}: ${
              err instanceof Error ? err.message : String(err)
            }. Leaving credentials in place.`,
          );
          return;
        }
      }
      if (!fs.existsSync(dest)) {
        console.error(
          `[provider-accounts] ${provider} legacy migration: ${dest} missing after copy; `
            + `leaving ${legacy} in place.`,
        );
        return;
      }
      fs.rmSync(legacy, { recursive: true, force: true });
    }

    const now = Date.now();
    this.credentialStore.upsertCredentialRoute({
      id: accountId,
      serviceId,
      billingMode: ACCOUNT_BILLING_MODE,
      via: "account",
      label,
      isPrimary: false,
      priority: 0,
      status: "ready",
      capabilities: {
        source: "manual_default",
        refreshedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });
  }
}

export function providerAccountCredentialRoot(
  credentialsDir: string,
  provider: AgentId,
  accountId: string,
): string {
  return path.join(credentialsDir, PROVIDER_ACCOUNTS_SUBDIR, accountOwnerHarness(provider), accountId);
}

function generatedAccountLabel(provider: AgentId, existing: readonly CredentialRoute[]): string {
  const base = PROVIDER_LABEL[provider];
  const taken = new Set(existing.map((account) => account.label));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function normalizeLabel(label: string | undefined): string | null {
  const normalized = typeof label === "string" ? label.trim() : "";
  return normalized || null;
}

export function isSessionContainerCredentialRoot(): boolean {
  return (process.env.SHIPIT_SESSION_ID ?? "") !== "";
}

function isNonEmptyFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    return stat !== undefined && stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

// Stable sorting preserves user priority on ties; synchronous usage stamps separate bursts.
export function orderForSelectionMode<T extends { lastUsedAt?: number }>(
  accounts: readonly T[],
  mode: AccountSelectionMode,
): T[] {
  if (mode !== "balanced") return [...accounts];
  return [...accounts].sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
}

export function snapshotExhaustedResetAt(
  limits: { session?: unknown; weekly?: unknown } | undefined,
  now: number,
): number | null {
  const resets: number[] = [];
  for (const key of ["session", "weekly"] as const) {
    const window = limits?.[key] as { usedPct: number | null; resetAt: string } | null | undefined;
    if (window === null || window === undefined) continue;
    if (window.usedPct === null || window.usedPct < 100) continue;
    if (!subscriptionWindowIsCurrent(window, now)) continue;
    resets.push(Date.parse(window.resetAt));
  }
  if (resets.length === 0) return null;
  return Math.min(...resets);
}

function readClaudeAccessToken(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return probeNestedString(
      parsed as Record<string, unknown>,
      ["accessToken", "access_token"],
      "claudeAiOauth",
    );
  } catch {
    return null;
  }
}

export function isOverCutoff(
  limits: { session?: unknown; weekly?: unknown } | undefined,
  cutoffs: FailoverCutoffs,
  now: number,
): boolean {
  for (const [key, cutoff] of [["session", cutoffs.session], ["weekly", cutoffs.weekly]] as const) {
    const window = limits?.[key] as { usedPct: number | null; resetAt?: unknown } | null | undefined;
    if (window?.usedPct === null || window?.usedPct === undefined) continue;
    if (!subscriptionWindowIsCurrent(window, now)) continue;
    if (window.usedPct >= cutoff) return true;
  }
  return false;
}

function legacyRank(
  entry: { route: CredentialRoute; index: number },
  primaryId: string | undefined,
): number {
  if (typeof entry.route.priority === "number") return entry.route.priority;
  if (entry.route.id === primaryId) return Number.NEGATIVE_INFINITY;
  return entry.index;
}
