import fs from "node:fs";
import path from "node:path";
import { getErrorMessage } from "../shared/utils.js";
import { isEncrypted, type SecretCipher } from "./secret-cipher.js";
import type {
  McpServerConfig,
  OAuthTokens,
  McpOAuthRegisteredClient,
} from "../shared/types/mcp-types.js";
import type {
  AgentId,
  AccountSelectionMode,
  AgentRole,
  CredentialBillingMode,
  CredentialRoute,
  FailoverCutoffs,
  ReviewerPin,
  ReviewerSlot,
  RolePinnedParams,
} from "../shared/types.js";
import {
  credentialModeKey,
  DEFAULT_SELECTION_MODE,
  RESERVED_ROLE_NAME,
  REVIEWER_SLOTS,
} from "../shared/types.js";
import { DEFAULT_FAILOVER_CUTOFF } from "../shared/types.js";
import { subscriptionWindowIsCurrent } from "../shared/types/usage-limits-types.js";
import type { VoiceDeliveryMode } from "../shared/types/voice-note-types.js";
import {
  allServices,
  getMode,
  nativeServiceForHarness,
  selectionExists,
  storageEnvFor,
} from "../shared/catalogue/index.js";
import type { ModelSelection } from "../shared/catalogue/index.js";
import { APPLIED, applyFailed, combineOutcomes, credentialStoreField, GLOBAL_SETTINGS } from "../shared/settings-catalogue/index.js";
import type { ApplyOutcome } from "../shared/settings-catalogue/index.js";
import type {
  AnySettingDeclaration,
  CredentialStoreSettingField,
  CredentialStoreSettingKey,
  GlobalSettingsCatalogue,
  SettingValue,
} from "../shared/settings-catalogue/index.js";

interface LinearTrackerConfig {
  token?: string;
}

interface LegacyProviderAccountRow extends Omit<CredentialRoute, "serviceId" | "billingMode" | "via"> {
  provider: AgentId;
}

// The reserved reviewer stores metadata only; its automatic params are derived on read.
interface StoredRole {
  description?: string;
  prompt?: string;
  params?: RolePinnedParams;
}

// The catalogue owns these fields' type, default and validation (docs/299).
type DeclaredSettingsData = Partial<Record<CredentialStoreSettingField, unknown>>;

interface CredentialData extends DeclaredSettingsData {
  agentEnv?: Record<string, string>;
  githubToken?: string;
  linear?: LinearTrackerConfig;
  failoverCutoffs?: Record<string, FailoverCutoffs>;
  accountSelectionMode?: Record<string, AccountSelectionMode>;
  reviewers?: Partial<Record<ReviewerSlot, ReviewerPin>>;
  roles?: Record<string, StoredRole>;
  mcpServers?: Record<string, McpServerConfig>;
  mcpOAuth?: Record<string, OAuthTokens>;
  // Registration can precede tokens and survives disconnects for reuse.
  mcpOAuthClients?: Record<string, McpOAuthRegisteredClient>;
  // Frozen after migration, retained for downgrade compatibility.
  providerAccounts?: Partial<Record<AgentId, LegacyProviderAccountRow[]>>;
  credentialRoutes?: CredentialRoute[];
  // Server-only, keyed by route ID so multiple credentials can share a destination env name.
  credentialSecrets?: Record<string, string>;
  voiceProviderKeys?: Record<string, string>;
  voiceWebhook?: { url: string; token: string };
  // Survives credential removal so completed onboarding does not return.
  harnessOnboardingCompletedAt?: string;
  // importedValue detects manual replacement; removed prevents reimport after user deletion.
  adoptedEnvCredentials?: Record<string, { importedValue?: string; removed?: boolean }>;
}

export const MAX_ROLE_NAME_LENGTH = 10_000;
export const MAX_ROLE_DESCRIPTION_LENGTH = 500;
export const MAX_ROLE_PROMPT_LENGTH = 20_000;

const DEFAULT_CREDENTIALS_DIR = "/credentials";
const FILENAME = "shipit-credentials.json";

export class CredentialStore {
  private filePath: string;
  private data: CredentialData = {};
  private cipher?: SecretCipher;
  /** The last serialization known to be on disk — what `save()` rolls back to. */
  private persisted = "{}";
  /** Set while a {@link transact} group is open; each `save()` reports into it. */
  private writeReport: ApplyOutcome[] | null = null;

  constructor(credentialsDir?: string, cipher?: SecretCipher) {
    this.filePath = path.join(credentialsDir ?? DEFAULT_CREDENTIALS_DIR, FILENAME);
    this.cipher = cipher;
    this.load();
    this.persisted = JSON.stringify(this.data, null, 2);
    this.migrateProviderAccountsToRoutes();
    this.migrateAgentEnvKeysToRoutes();
    this.migrateRoutingSettingsKeys();
  }

  // Move catalogue keys; a surviving agentEnv copy would bypass later route deletion.
  private migrateAgentEnvKeysToRoutes(): void {
    const env = this.data.agentEnv;
    if (!env) return;
    let changed = false;
    for (const service of allServices()) {
      for (const mode of service.modes) {
        const envName = storageEnvFor(service.id, mode.kind);
        if (!envName) continue;
        const value = env[envName];
        if (typeof value !== "string" || !value) continue;
        const already = this.listCredentialRoutes(service.id, mode.kind).some((r) => r.via === "string");
        const now = Date.now();
        if (!already) {
          const id = `cred_${service.id}_${mode.kind}`;
          this.data.credentialRoutes = [
            ...(this.data.credentialRoutes ?? []),
            {
              id,
              serviceId: service.id,
              billingMode: mode.kind,
              via: "string",
              label: `${service.name} key`,
              labelIsGenerated: true,
              isPrimary: false,
              priority: 0,
              status: "ready",
              createdAt: now,
              updatedAt: now,
            },
          ];
          this.data.credentialSecrets = { ...(this.data.credentialSecrets ?? {}), [id]: value };
        }
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by a catalogue storageEnv name
        delete env[envName];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  // Even an empty credentialRoutes array marks migration complete; never resurrect deleted accounts.
  private migrateProviderAccountsToRoutes(): void {
    if (this.data.credentialRoutes) return;
    const legacy = this.data.providerAccounts;
    const routes: CredentialRoute[] = [];
    for (const [provider, accounts] of Object.entries(legacy ?? {})) {
      const serviceId = nativeServiceForHarness(provider as AgentId);
      if (!serviceId) {
        console.warn(
          `[credential-store] cannot migrate ${provider} accounts: no catalogue service for that harness`,
        );
        continue;
      }
      for (const { provider: _provider, ...rest } of accounts ?? []) {
        routes.push({ ...rest, serviceId, billingMode: "sub", via: "account" });
      }
    }
    this.data.credentialRoutes = routes;
    this.save();
  }

  private migrateRoutingSettingsKeys(): void {
    let changed = false;
    const rekey = <T>(map: Record<string, T> | undefined): Record<string, T> | undefined => {
      if (!map) return map;
      const next: Record<string, T> = {};
      // Migrated keys win regardless of JSON key order.
      for (const [key, value] of Object.entries(map)) {
        if (key.includes(":")) next[key] = value;
      }
      for (const [key, value] of Object.entries(map)) {
        if (key.includes(":")) continue;
        const serviceId = nativeServiceForHarness(key as AgentId);
        if (!serviceId) continue;
        const target = credentialModeKey(serviceId, "sub");
        changed = true;
        if (target in next) continue;
        next[target] = value;
      }
      return next;
    };
    this.data.failoverCutoffs = rekey(this.data.failoverCutoffs);
    this.data.accountSelectionMode = rekey(this.data.accountSelectionMode);
    if (changed) this.save();
  }


  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch {
      this.data = {};
      return;
    }

    const trimmed = raw.trim();
    if (isEncrypted(trimmed)) {
      if (!this.cipher) {
        // Do not reset encrypted data to an empty store that a later save would overwrite.
        throw new Error(
          `[credential-store] ${this.filePath} is encrypted but no encryption ` +
            "key is configured. Provide SHIPIT_SECRET_KEY / restore the key file, " +
            "or run a deliberate decrypt-export before disabling encryption.",
        );
      }
      this.data = JSON.parse(this.cipher.decrypt(trimmed)) as CredentialData;
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        this.data = parsed;
      }
    } catch {
      this.data = {};
      return;
    }

    // Encryption migration must persist or fail; save() would swallow the write error.
    if (this.cipher) {
      try {
        this.writeToDisk();
      } catch (err) {
        throw new Error(
          `[credential-store] Failed to re-encrypt legacy credentials at ${this.filePath}: ${getErrorMessage(err)}`,
          { cause: err },
        );
      }
    }
  }

  private writeToDisk(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const serialized = JSON.stringify(this.data, null, 2);
    const payload = this.cipher ? this.cipher.encrypt(serialized) : serialized;
    fs.writeFileSync(this.filePath, payload, { mode: 0o600 });
    // writeFileSync's mode does not repair existing file permissions.
    fs.chmodSync(this.filePath, 0o600);
    this.persisted = serialized;
  }

  /**
   * Persist the mutation the caller has already made in memory, or undo it.
   *
   * A value reported saved that vanishes at the next restart is a lie nothing
   * downstream can detect, so a failed write rolls the store back to what is
   * actually on disk and says `failed` (docs/299-agent-settings-access →
   * "Saved" has to mean saved). Rolling back to the last persisted serialization
   * rather than to a per-call snapshot is what keeps every one of the callers
   * unchanged: each mutates and calls this immediately, so the two states differ
   * by exactly the write that failed.
   */
  private save(): ApplyOutcome {
    let outcome: ApplyOutcome;
    try {
      this.writeToDisk();
      outcome = APPLIED;
    } catch (err) {
      this.data = JSON.parse(this.persisted) as CredentialData;
      console.error("[credential-store] Failed to save:", getErrorMessage(err));
      outcome = applyFailed(
        "ShipIt could not write its credential store, so the change was rolled back and nothing was saved.",
      );
    }
    this.writeReport?.push(outcome);
    return outcome;
  }

  /**
   * Run a group of mutations as one reported write. Every setter inside saves
   * exactly as it does today; this collects whether each of those saves reached
   * disk, so a caller may say `applied` only when they all did — and hears
   * `partial` when an earlier write landed and a later one was rolled back.
   *
   * Synchronous mutations only. An `await` inside would let an unrelated write
   * from elsewhere in the process be counted as part of this group, which is the
   * one way this can report something that never happened.
   */
  transact<T>(mutate: () => T): { value: T; outcome: ApplyOutcome } {
    const outer = this.writeReport;
    const report = outer ?? [];
    const from = report.length;
    this.writeReport = report;
    try {
      const value = mutate();
      return { value, outcome: combineOutcomes(report.slice(from)) };
    } finally {
      this.writeReport = outer;
    }
  }

  getHarnessOnboardingCompletedAt(): string | undefined {
    const value = this.data.harnessOnboardingCompletedAt;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  // Memory-only completion would vanish at restart, so a failed write reports none.
  stampHarnessOnboardingCompleted(at: string): string | undefined {
    const existing = this.getHarnessOnboardingCompletedAt();
    if (existing) return existing;
    this.data.harnessOnboardingCompletedAt = at;
    return this.save().status === "applied" ? at : undefined;
  }

  // Storage order; ProviderAccountManager derives selection order and primary status.
  listCredentialRoutes(serviceId?: string, billingMode?: CredentialBillingMode): CredentialRoute[] {
    return (this.data.credentialRoutes ?? [])
      .filter((r) => (serviceId === undefined || r.serviceId === serviceId)
        && (billingMode === undefined || r.billingMode === billingMode))
      .map((r) => ({ ...r }));
  }

  getCredentialRoute(routeId: string): CredentialRoute | undefined {
    const found = this.data.credentialRoutes?.find((r) => r.id === routeId);
    return found ? { ...found } : undefined;
  }

  upsertCredentialRoute(route: CredentialRoute): void {
    const routes = [...(this.data.credentialRoutes ?? [])];
    const idx = routes.findIndex((r) => r.id === route.id);
    const next = { ...route, updatedAt: Date.now() };
    if (idx >= 0) routes[idx] = next;
    else routes.push(next);
    this.data.credentialRoutes = routes;
    this.save();
  }

  deleteCredentialRoute(routeId: string): void {
    this.data.credentialRoutes = (this.data.credentialRoutes ?? []).filter((r) => r.id !== routeId);
    const secrets = { ...(this.data.credentialSecrets ?? {}) };
    if (routeId in secrets) {
      const { [routeId]: _removed, ...rest } = secrets;
      this.data.credentialSecrets = rest;
    }
    this.save();
  }

  // Persist route and secret together so a crash cannot leave a ready route without its secret.
  upsertCredentialRouteWithSecret(route: CredentialRoute, secret: string): void {
    const routes = [...(this.data.credentialRoutes ?? [])];
    const idx = routes.findIndex((r) => r.id === route.id);
    const next = { ...route, updatedAt: Date.now() };
    if (idx >= 0) routes[idx] = next;
    else routes.push(next);
    this.data.credentialRoutes = routes;
    this.data.credentialSecrets = { ...(this.data.credentialSecrets ?? {}), [route.id]: secret };
    this.save();
  }

  getCredentialSecret(routeId: string): string | undefined {
    const value = this.data.credentialSecrets?.[routeId];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  setCredentialSecret(routeId: string, secret: string): void {
    this.data.credentialSecrets = { ...(this.data.credentialSecrets ?? {}), [routeId]: secret };
    // Saving even the same secret allows another attempt; persist status and secret together.
    const route = this.getCredentialRoute(routeId);
    if (route?.via === "string" && route.status === "auth_failed") {
      this.data.credentialRoutes = (this.data.credentialRoutes ?? []).map((r) =>
        r.id === routeId ? { ...r, status: "ready" as const, updatedAt: Date.now() } : r,
      );
    }
    this.save();
  }

  getAdoptedEnvCredential(storageEnv: string): { importedValue?: string; removed?: boolean } | undefined {
    return this.data.adoptedEnvCredentials?.[storageEnv];
  }

  setAdoptedEnvCredential(
    storageEnv: string,
    patch: { importedValue?: string; removed?: boolean },
  ): void {
    const current = this.data.adoptedEnvCredentials ?? {};
    this.data.adoptedEnvCredentials = {
      ...current,
      [storageEnv]: { ...current[storageEnv], ...patch },
    };
    this.save();
  }

  // The latest refusal replaces earlier estimates, even when its reset is sooner.
  markCredentialRouteExhausted(routeId: string, until: number): CredentialRoute | null {
    const route = this.getCredentialRoute(routeId);
    if (route?.billingMode !== "sub") return null;
    this.upsertCredentialRoute({
      ...route,
      exhaustedUntil: until,
      exhaustedAt: Date.now(),
    });
    return this.getCredentialRoute(routeId) ?? null;
  }

  clearCredentialRefusalOnHealthyReading(
    routeId: string,
    snapshot: { session?: unknown; weekly?: unknown; fetchedAt?: unknown } | undefined,
  ): boolean {
    const route = this.getCredentialRoute(routeId);
    if (route?.exhaustedUntil === null || route?.exhaustedUntil === undefined) return false;
    if (!snapshot || typeof snapshot.fetchedAt !== "number" || !Number.isFinite(snapshot.fetchedAt)) return false;
    const observedAt = typeof route.exhaustedAt === "number" ? route.exhaustedAt : 0;
    if (snapshot.fetchedAt <= observedAt) return false;
    const now = Date.now();
    for (const key of ["session", "weekly"] as const) {
      const window = snapshot[key] as { usedPct?: unknown; resetAt?: unknown } | null | undefined;
      if (!subscriptionWindowIsCurrent(window, now)) continue;
      if (typeof window?.usedPct === "number" && window.usedPct >= 100) return false;
    }
    this.upsertCredentialRoute({ ...route, exhaustedUntil: null, exhaustedAt: null });
    return true;
  }

  markCredentialRouteUsed(routeId: string): void {
    const route = this.getCredentialRoute(routeId);
    if (!route) return;
    this.upsertCredentialRoute({ ...route, lastUsedAt: Date.now() });
  }

  // String credentials stay selectable: successful use can clear a transient auth failure.
  markCredentialRouteAuthFailed(routeId: string): boolean {
    const route = this.getCredentialRoute(routeId);
    if (route?.via !== "string" || route.status === "auth_failed") return false;
    this.upsertCredentialRoute({ ...route, status: "auth_failed" });
    return true;
  }

  clearCredentialRouteAuthFailed(routeId: string): boolean {
    const route = this.getCredentialRoute(routeId);
    if (route?.via !== "string" || route.status !== "auth_failed") return false;
    this.upsertCredentialRoute({ ...route, status: "ready" });
    return true;
  }

  getAgentEnv(key: string): string | undefined {
    return this.data.agentEnv?.[key];
  }

  getAllAgentEnv(): Record<string, string> {
    return { ...this.data.agentEnv };
  }

  setAgentEnv(key: string, value: string): void {
    this.data.agentEnv ??= {};
    this.data.agentEnv[key] = value;
    this.save();
  }

  getMcpServer(name: string): McpServerConfig | undefined {
    return this.data.mcpServers?.[name];
  }

  getAllMcpServers(): Record<string, McpServerConfig> {
    return { ...this.data.mcpServers };
  }

  setMcpServer(name: string, config: McpServerConfig): void {
    this.data.mcpServers ??= {};
    this.data.mcpServers[name] = { ...config, name };
    this.save();
  }

  deleteMcpServer(name: string): void {
    if (this.data.mcpServers) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by user-provided server name
      delete this.data.mcpServers[name];
      this.save();
    }
  }

  setMcpSecret(key: string, value: string): void {
    if (!key.startsWith("mcp__")) {
      throw new Error(`MCP secret key must start with "mcp__": ${key}`);
    }
    this.setAgentEnv(key, value);
  }

  deleteMcpSecret(key: string): void {
    if (this.data.agentEnv && key in this.data.agentEnv) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by mcp__* secret name
      delete this.data.agentEnv[key];
      this.save();
    }
  }

  deleteMcpSecretsForServer(serverName: string): void {
    if (!this.data.agentEnv) return;
    const prefix = `mcp__${serverName}__`;
    let changed = false;
    for (const key of Object.keys(this.data.agentEnv)) {
      if (key.startsWith(prefix)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by mcp__* secret name
        delete this.data.agentEnv[key];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  getMcpOAuthTokens(source: string): OAuthTokens | undefined {
    const t = this.data.mcpOAuth?.[source];
    return t ? { ...t } : undefined;
  }

  getAllMcpOAuthTokens(): Record<string, OAuthTokens> {
    const out: Record<string, OAuthTokens> = {};
    for (const [k, v] of Object.entries(this.data.mcpOAuth ?? {})) {
      out[k] = { ...v };
    }
    return out;
  }

  setMcpOAuthTokens(source: string, tokens: OAuthTokens): void {
    this.data.mcpOAuth ??= {};
    this.data.mcpOAuth[source] = {
      ...tokens,
      obtainedAt: tokens.obtainedAt ?? new Date().toISOString(),
    };
    this.save();
  }

  deleteMcpOAuthTokens(source: string): void {
    if (this.data.mcpOAuth && source in this.data.mcpOAuth) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by provider source id
      delete this.data.mcpOAuth[source];
      this.save();
    }
  }

  getMcpOAuthClient(source: string): McpOAuthRegisteredClient | undefined {
    const c = this.data.mcpOAuthClients?.[source];
    return c ? { ...c } : undefined;
  }

  setMcpOAuthClient(source: string, client: McpOAuthRegisteredClient): void {
    this.data.mcpOAuthClients ??= {};
    this.data.mcpOAuthClients[source] = { ...client };
    this.save();
  }

  deleteMcpOAuthClient(source: string): void {
    if (this.data.mcpOAuthClients && source in this.data.mcpOAuthClients) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by provider source id
      delete this.data.mcpOAuthClients[source];
      this.save();
    }
  }

  getGithubToken(): string | null {
    const token = this.data.githubToken;
    if (typeof token === "string" && token.trim()) {
      return token;
    }
    return null;
  }

  setGithubToken(token: string): void {
    this.data.githubToken = token;
    this.save();
  }

  clearGithubToken(): void {
    delete this.data.githubToken;
    this.save();
  }

  getLinearToken(): string | null {
    const token = this.data.linear?.token;
    if (typeof token === "string" && token.trim()) {
      return token;
    }
    return null;
  }

  setLinearToken(token: string): void {
    this.data.linear ??= {};
    this.data.linear.token = token;
    this.save();
  }

  clearLinear(): void {
    if (this.data.linear) {
      delete this.data.linear;
      this.save();
    }
  }

  getVoiceProviderKey(providerId: string): string | null {
    const key = this.data.voiceProviderKeys?.[providerId];
    if (typeof key === "string" && key.trim()) {
      return key;
    }
    return null;
  }

  setVoiceProviderKey(providerId: string, key: string): void {
    this.data.voiceProviderKeys ??= {};
    this.data.voiceProviderKeys[providerId] = key;
    this.save();
  }

  clearVoiceProviderKey(providerId: string): void {
    if (this.data.voiceProviderKeys && providerId in this.data.voiceProviderKeys) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by provider id
      delete this.data.voiceProviderKeys[providerId];
      this.save();
    }
  }

  getConfiguredVoiceProviders(): string[] {
    return Object.entries(this.data.voiceProviderKeys ?? {})
      .filter(([, v]) => typeof v === "string" && v.trim())
      .map(([id]) => id);
  }

  /** The catalogue carries the default and how a stored value is interpreted. */
  getDeclaredSetting<K extends CredentialStoreSettingKey>(
    key: K,
  ): SettingValue<GlobalSettingsCatalogue[K]> {
    const declaration = GLOBAL_SETTINGS[key];
    return declaration.type.read(this.data[credentialStoreField(key)]) as SettingValue<
      GlobalSettingsCatalogue[K]
    >;
  }

  /** Throws when the value fails the declared validation, so a bad write cannot persist. */
  setDeclaredSetting(key: CredentialStoreSettingKey, value: unknown): void {
    const declaration: AnySettingDeclaration = GLOBAL_SETTINGS[key];
    const checked = declaration.type.validate(value, declaration.label);
    if (!checked.ok) throw new Error(checked.message);
    const field = credentialStoreField(key);
    const stored = declaration.type.serialize(checked.value);
    if (stored === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by a declared setting's field
      delete this.data[field];
    } else {
      this.data[field] = stored;
    }
    this.save();
  }

  getVoiceDeliveryMode(): VoiceDeliveryMode {
    return this.getDeclaredSetting("voice.deliveryMode");
  }

  setVoiceDeliveryMode(mode: VoiceDeliveryMode): void {
    this.setDeclaredSetting("voice.deliveryMode", mode);
  }

  getVoiceWebhook(): { url: string; token: string } | null {
    const wh = this.data.voiceWebhook;
    if (wh && typeof wh.url === "string" && wh.url.trim()) {
      return { url: wh.url, token: typeof wh.token === "string" ? wh.token : "" };
    }
    return null;
  }

  setVoiceWebhook(url: string, token: string): void {
    this.data.voiceWebhook = { url, token };
    this.save();
  }

  clearVoiceWebhook(): void {
    if (this.data.voiceWebhook) {
      delete this.data.voiceWebhook;
      this.save();
    }
  }

  /** The configured budget in MB, or `null` for "the host is the budget". */
  getMemoryBudgetMb(): number | null {
    return this.getDeclaredSetting("advanced.memoryBudgetMb");
  }

  setMemoryBudgetMb(mb: number | null): void {
    this.setDeclaredSetting("advanced.memoryBudgetMb", mb);
  }

  getAgentSystemInstructionsEnabled(): boolean {
    return this.getDeclaredSetting("instructions.agentInstructionsEnabled");
  }

  setAgentSystemInstructionsEnabled(enabled: boolean): void {
    this.setDeclaredSetting("instructions.agentInstructionsEnabled", enabled);
  }

  getAutoCreatePr(): boolean {
    return this.getDeclaredSetting("integrations.autoCreatePr");
  }

  setAutoCreatePr(enabled: boolean): void {
    this.setDeclaredSetting("integrations.autoCreatePr", enabled);
  }

  // Steering avoids resume errors from interrupted turns with signed thinking blocks.
  getLiveSteering(): boolean {
    return this.getDeclaredSetting("advanced.liveSteering");
  }

  setLiveSteering(enabled: boolean): void {
    this.setDeclaredSetting("advanced.liveSteering", enabled);
  }

  getFailoverCutoffs(serviceId: string, billingMode: CredentialBillingMode): FailoverCutoffs {
    const stored = this.data.failoverCutoffs?.[credentialModeKey(serviceId, billingMode)];
    return {
      session: clampCutoff(stored?.session),
      weekly: clampCutoff(stored?.weekly),
    };
  }

  setFailoverCutoffs(
    serviceId: string,
    billingMode: CredentialBillingMode,
    cutoffs: Partial<FailoverCutoffs>,
  ): FailoverCutoffs {
    const current = this.getFailoverCutoffs(serviceId, billingMode);
    const next: FailoverCutoffs = {
      session: cutoffs.session === undefined ? current.session : clampCutoff(cutoffs.session),
      weekly: cutoffs.weekly === undefined ? current.weekly : clampCutoff(cutoffs.weekly),
    };
    this.data.failoverCutoffs = {
      ...this.data.failoverCutoffs,
      [credentialModeKey(serviceId, billingMode)]: next,
    };
    this.save();
    return next;
  }

  getSelectionMode(serviceId: string, billingMode: CredentialBillingMode): AccountSelectionMode {
    const stored = this.data.accountSelectionMode?.[credentialModeKey(serviceId, billingMode)];
    return stored === "strict" || stored === "balanced" ? stored : DEFAULT_SELECTION_MODE;
  }

  setSelectionMode(
    serviceId: string,
    billingMode: CredentialBillingMode,
    mode: AccountSelectionMode,
  ): AccountSelectionMode {
    this.data.accountSelectionMode = {
      ...this.data.accountSelectionMode,
      [credentialModeKey(serviceId, billingMode)]: mode,
    };
    this.save();
    return mode;
  }

  getAutoResolveConflicts(): boolean {
    return this.getDeclaredSetting("advanced.autoResolveConflicts");
  }

  setAutoResolveConflicts(enabled: boolean): void {
    this.setDeclaredSetting("advanced.autoResolveConflicts", enabled);
  }

  getAutoFixCi(): boolean {
    return this.getDeclaredSetting("advanced.autoFixCi");
  }

  setAutoFixCi(enabled: boolean): void {
    this.setDeclaredSetting("advanced.autoFixCi", enabled);
  }

  getAutoResetMergedBranch(): boolean {
    return this.getDeclaredSetting("advanced.autoResetMergedBranch");
  }

  setAutoResetMergedBranch(enabled: boolean): void {
    this.setDeclaredSetting("advanced.autoResetMergedBranch", enabled);
  }

  getEnableSubAgents(): boolean {
    return this.getDeclaredSetting("advanced.enableSubAgents");
  }

  setEnableSubAgents(enabled: boolean): void {
    this.setDeclaredSetting("advanced.enableSubAgents", enabled);
  }

  getNonTurnModel(): ModelSelection | undefined {
    return this.getDeclaredSetting("services.nonTurnModel") ?? undefined;
  }

  setNonTurnModel(selection: ModelSelection | null): void {
    this.setDeclaredSetting("services.nonTurnModel", selection);
  }

  // A failed seed must not remain in memory as a saved setting.
  stampNonTurnModel(selection: ModelSelection): ModelSelection | undefined {
    const existing = this.getNonTurnModel();
    if (existing) return existing;
    if (!selectionExists(selection)) {
      throw new Error(
        `No catalogue entry for ${selection.serviceId}/${selection.billingMode}/${selection.modelId}`,
      );
    }
    this.data.nonTurnModel = { ...selection };
    return this.save().status === "applied" ? { ...selection } : undefined;
  }

  getReviewerPin(slot: ReviewerSlot): ReviewerPin | undefined {
    const stored = this.data.reviewers?.[slot];
    if (!stored) return undefined;
    if (selectionExists(stored)) return { ...stored };
    const retired = getMode(stored.serviceId, stored.billingMode)?.retired.some(
      (r) => r.id === stored.modelId,
    );
    return retired ? { ...stored } : undefined;
  }

  getReviewerPins(): Partial<Record<ReviewerSlot, ReviewerPin>> {
    const out: Partial<Record<ReviewerSlot, ReviewerPin>> = {};
    for (const slot of REVIEWER_SLOTS) {
      const pin = this.getReviewerPin(slot);
      if (pin) out[slot] = pin;
    }
    return out;
  }

  setReviewerPin(slot: ReviewerSlot, pin: ReviewerPin | null): void {
    const current: Partial<Record<ReviewerSlot, ReviewerPin>> = {};
    for (const other of REVIEWER_SLOTS) {
      const existing = this.data.reviewers?.[other];
      if (other !== slot && existing) current[other] = existing;
    }
    if (pin !== null) {
      if (!selectionExists(pin)) {
        throw new Error(
          `No catalogue entry for ${pin.serviceId}/${pin.billingMode}/${pin.modelId}`,
        );
      }
      // Harness-specific effort validation belongs to resolveReviewerPinPatch.
      if (pin.reasoningEffort !== undefined && !pin.reasoningEffort.trim()) {
        throw new Error("A pinned reviewer's reasoning level must not be blank (docs/261 req 5)");
      }
      current[slot] = {
        serviceId: pin.serviceId,
        billingMode: pin.billingMode,
        modelId: pin.modelId,
        ...(pin.reasoningEffort !== undefined ? { reasoningEffort: pin.reasoningEffort } : {}),
      };
    }
    this.data.reviewers = current;
    this.save();
  }

  getRoles(): AgentRole[] {
    const stored = this.data.roles ?? {};
    const out: AgentRole[] = [];
    for (const [name, role] of Object.entries(stored)) {
      if (name === RESERVED_ROLE_NAME || !role.params) continue;
      out.push({
        name,
        ...(role.description ? { description: role.description } : {}),
        ...(role.prompt ? { prompt: role.prompt } : {}),
        params: { ...role.params },
      });
    }
    out.push(this.reviewerRole());
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  getRole(name: string): AgentRole | undefined {
    if (name === RESERVED_ROLE_NAME) return this.reviewerRole();
    const stored = this.data.roles?.[name];
    if (!stored?.params) return undefined;
    return {
      name,
      ...(stored.description ? { description: stored.description } : {}),
      ...(stored.prompt ? { prompt: stored.prompt } : {}),
      params: { ...stored.params },
    };
  }

  // Callers must validate pinned params through services/roles.ts before storing them.
  setRole(name: string, role: AgentRole | null): void {
    // Test blankness without normalizing the stored name.
    if (!name.trim()) throw new Error("A role name cannot be blank");
    if (name.length > MAX_ROLE_NAME_LENGTH) {
      throw new Error(`A role name cannot be longer than ${MAX_ROLE_NAME_LENGTH} characters`);
    }
    if (role === null) {
      if (name === RESERVED_ROLE_NAME) {
        throw new Error(`The "${RESERVED_ROLE_NAME}" role cannot be deleted (docs/264-agent-roles req 2)`);
      }
      if (!this.data.roles?.[name]) return;
      const next: Record<string, StoredRole> = {};
      for (const [key, value] of Object.entries(this.data.roles)) {
        if (key !== name) next[key] = value;
      }
      this.data.roles = next;
      this.save();
      return;
    }
    if (name === RESERVED_ROLE_NAME) {
      if (role.params.kind !== "auto") {
        throw new Error(
          `The "${RESERVED_ROLE_NAME}" role's params are resolved by ShipIt and cannot be pinned `
            + "(docs/264-agent-roles req 2). Its description and standing instructions are editable.",
        );
      }
    } else if (role.params.kind === "auto") {
      throw new Error(
        `Only the "${RESERVED_ROLE_NAME}" role may have automatic params (docs/264-agent-roles req 2); `
          + `"${name}" must name a harness, a service, a billing mode, a model and a level `
          + "(or omit the level for Default).",
      );
    }
    const description = role.description?.trim();
    const prompt = role.prompt?.trim();
    if (description && description.length > MAX_ROLE_DESCRIPTION_LENGTH) {
      throw new Error(
        `A role description cannot be longer than ${MAX_ROLE_DESCRIPTION_LENGTH} characters`,
      );
    }
    if (prompt && prompt.length > MAX_ROLE_PROMPT_LENGTH) {
      throw new Error(
        `A role's standing instructions cannot be longer than ${MAX_ROLE_PROMPT_LENGTH} characters`,
      );
    }
    this.data.roles = {
      ...this.data.roles,
      [name]: {
        ...(description ? { description } : {}),
        ...(prompt ? { prompt } : {}),
        ...(role.params.kind === "pinned" ? { params: { ...role.params } } : {}),
      },
    };
    this.save();
  }

  private reviewerRole(): AgentRole {
    const stored = this.data.roles?.[RESERVED_ROLE_NAME];
    return {
      name: RESERVED_ROLE_NAME,
      ...(stored?.description ? { description: stored.description } : {}),
      ...(stored?.prompt ? { prompt: stored.prompt } : {}),
      params: { kind: "auto" },
    };
  }

  clear(): void {
    this.data = {};
    this.save();
  }
}

function clampCutoff(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FAILOVER_CUTOFF;
  return Math.min(100, Math.max(1, Math.round(value)));
}
