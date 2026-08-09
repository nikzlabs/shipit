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
  CredentialBillingMode,
  CredentialRoute,
  FailoverCutoffs,
  ProviderAccount,
  SubAgentDefaults,
  SubAgentDefaultsPatch,
} from "../shared/types.js";
import { credentialModeKey, DEFAULT_SELECTION_MODE } from "../shared/types.js";
import { DEFAULT_FAILOVER_CUTOFF } from "../shared/types.js";
import type { VoiceDeliveryMode } from "../shared/types/voice-note-types.js";
import { DEFAULT_VOICE_DELIVERY_MODE } from "../shared/types/voice-note-types.js";
import {
  allServices,
  harnessForNativeService,
  modesOfferingModel,
  nativeServiceForHarness,
  resolveModelSelection,
  resolveRetiredModelId,
  retirementSuccessor,
  storageEnvFor,
} from "../shared/catalogue/index.js";
import type { BillingMode } from "../shared/catalogue/index.js";

/**
 * docs/170 — the Linear **credential**, and nothing that identifies a
 * destination. `token` is a personal API key; the workspace it can reach is a
 * property of the key. Server-side only — the token is never echoed back to the
 * browser (status reports configured-or-not).
 *
 * docs/248 req 4 — the stored `team` binding is gone. A Linear tracker's team is
 * part of the repository's declaration (`kind: linear`, `team: SHI`), so ShipIt's
 * settings surface holds the credential and nothing else. Deployments that had a
 * team stored lose their Linear tab until a repository declares one; that is a
 * clean break by decision — no migration warning, and ShipIt does not write a
 * declaration into anyone's `shipit.yaml`. The stale `team` key simply stops
 * being read.
 */
interface LinearTrackerConfig {
  token?: string;
}

interface CredentialData {
  agentEnv?: Record<string, string>;
  githubToken?: string;
  /** docs/170 — Linear Issues-tab binding. */
  linear?: LinearTrackerConfig;
  maxIdleContainers?: number;
  agentSystemInstructionsEnabled?: boolean;
  autoCreatePr?: boolean;
  /**
   * When true, mid-turn messages are steered to the running agent instead of
   * queued. Capability-gated: only active when the agent also sets
   * supportsSteering: true. (docs/140)
   */
  liveSteering?: boolean;
  /**
   * docs/150 reqs 4–6 — proactive failover cutoffs.
   *
   * docs/252 phase 2 re-keys this (and {@link accountSelectionMode}) from
   * `AgentId` to `credentialModeKey(serviceId, billingMode)`. Both are answers
   * to "which of these credentials next?", a question that belongs to the group
   * a turn routes within — which is the `(service, billing mode)` pair, not the
   * CLI. Legacy `AgentId` keys are migrated once at load.
   */
  failoverCutoffs?: Record<string, FailoverCutoffs>;
  /** docs/150 req 21 — account selection mode, keyed as {@link failoverCutoffs}. */
  accountSelectionMode?: Record<string, AccountSelectionMode>;
  /**
   * When true, the PR poller's auto-resolve loop fires when a tracked PR
   * transitions to CONFLICTING while the agent is idle. (docs/146)
   */
  autoResolveConflicts?: boolean;
  /**
   * docs/169 — when true, the PR poller's auto-fix-CI loop fires when a tracked
   * PR's checks go to FAILURE while the agent is idle. Global + persisted,
   * mirroring `autoResolveConflicts`; replaced the old per-session in-memory
   * toggle. Default off.
   */
  autoFixCi?: boolean;
  /**
   * docs/218 — when true, resuming a MERGED session whose branch hasn't moved
   * since the merge auto-resets the branch to the latest `origin/<base>` before
   * the turn runs (with a per-send opt-out control + a persisted card). Global +
   * persisted, a sibling of `autoResolveConflicts` / `autoFixCi`. Phase 2 ships it
   * default OFF; Phase 3 flips the default ON and adds the composer control.
   */
  autoResetMergedBranch?: boolean;
  /**
   * docs/144 — global gate for sub-agent spawning. When true, a pinned session's
   * agent may spawn another registered agent for a one-shot sub-task via the
   * `shipit agent run` CLI. Default off; when off the feature is fully inert and
   * no cross-agent credentials are ever provisioned.
   */
  enableSubAgents?: boolean;
  /**
   * docs/217 — per-agent defaults applied when this agent is invoked as a
   * SUB-agent (`shipit agent run --agent <id>` from inside another session).
   * Keyed by agent id. A per-agent object (not a scalar) so the group can grow
   * — `reasoningEffort` and a default `model` for the sub-agent invocation.
   * A field unset ⇒ the backend's native default (no `--effort` flag; `models[0]`).
   */
  agentSubAgentDefaults?: Record<string, SubAgentDefaults>;
  /**
   * Account-level MCP server configs keyed by name (docs/088). Values use
   * `$secret:` placeholders — the raw secret values live in `agentEnv` under
   * the `mcp__<server>__<KEY>` namespace, not here.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * MCP OAuth tokens (docs/088 Phase 2) keyed by provider source id
   * (e.g. `"notion_oauth"`). Tokens are written here after a successful
   * OAuth exchange and read into the agent's MCP env by
   * `collectMcpAgentEnv()` (refreshed lazily via `refreshExpiredMcpOAuthTokens()`
   * at startup / before each agent turn). Per provider registry, the source
   * id is uppercased into the env var name the worker substitutes for
   * `$platform:<id>` placeholders (`notion_oauth` → `MCP_PLATFORM_NOTION_OAUTH`).
   */
  mcpOAuth?: Record<string, OAuthTokens>;
  /**
   * Dynamically-registered OAuth clients (RFC 7591, docs/139) keyed by
   * provider source id. Kept separate from `mcpOAuth` so a registered client
   * can exist before the first token without falsely reporting "connected"
   * in `listMcpOAuthProviders`. Reused on every connect so we register once
   * per account/provider.
   */
  mcpOAuthClients?: Record<string, McpOAuthRegisteredClient>;
  /**
   * **Legacy, frozen.** docs/150's per-`AgentId` account rows. docs/252 phase 2
   * migrates these into {@link credentialRoutes} once, at load, and never reads
   * or writes them again — the blob is left on disk deliberately, as the
   * downgrade path for an install that rolls back before it connects anything
   * new. It is not a second live source: nothing writes it after the migration.
   */
  providerAccounts?: Partial<Record<AgentId, ProviderAccount[]>>;
  /**
   * docs/252 phase 2 — every credential the user holds, keyed by
   * `(serviceId, billingMode)` on each record. One flat array rather than a map
   * because the natural key is a pair and every read filters anyway.
   */
  credentialRoutes?: CredentialRoute[];
  /**
   * docs/252 phase 2 — the secret behind each `via: "string"` credential route,
   * keyed by route id.
   *
   * Per *instance*, which is the one piece of genuinely new persistence in this
   * design: `agentEnv` is a single `Record<string, string>` whose named slot the
   * next write overwrites, so a second GLM coding-plan key would destroy the
   * first — leaving req 12 with nothing to fail over to. Storage is keyed by
   * route id exactly as an account's credential root is keyed by account id;
   * the catalogue's `storageEnv` names the variable a credential is
   * *materialized into at spawn*, never where it is kept.
   *
   * Server-side only. {@link CredentialRoute} carries no secret precisely so
   * the route list stays safe to return verbatim through Settings.
   */
  credentialSecrets?: Record<string, string>;
  /**
   * Voice provider API keys (docs/144) keyed by provider id ("openai",
   * "elevenlabs", "deepgram", …). Each provider that needs its own credential
   * gets its own entry so STT, TTS, and cleanup can run on different accounts.
   * Server-side only — never returned to the browser (see plan threat model).
   */
  voiceProviderKeys?: Record<string, string>;
  /**
   * docs/163 — voice-note delivery mode: "native" (inline note + TTS),
   * "external" (webhook only), or "both". Server-side so the router can read
   * it without a client round-trip. Defaults to "native".
   */
  voiceDeliveryMode?: VoiceDeliveryMode;
  /**
   * docs/163 — external webhook sink config. The token is bearer auth sent to
   * the user's endpoint; like the voice provider keys it is server-side only
   * and never echoed to the browser (status reports configured-or-not).
   */
  voiceWebhook?: { url: string; token: string };
}

const DEFAULT_CREDENTIALS_DIR = "/credentials";
const FILENAME = "shipit-credentials.json";

/**
 * Unified credential store that persists user credentials to a single JSON file.
 * Lives in the credentials volume so it survives workspace resets and container restarts.
 *
 * Storage file: `{credentialsDir}/shipit-credentials.json`
 */
export class CredentialStore {
  private filePath: string;
  private data: CredentialData = {};
  private cipher?: SecretCipher;

  /**
   * @param cipher At-rest encryption (docs/220). When provided, the entire
   *   credentials JSON is encrypted as a single AES-256-GCM blob on disk — so
   *   every present and future field is covered without per-field plumbing. A
   *   legacy plaintext file is read transparently and re-encrypted once on
   *   construction. When omitted, the store behaves exactly as before
   *   (plaintext JSON) — this keeps the many `new CredentialStore(dir)` test
   *   call sites working; production injects a cipher from app-di.
   */
  constructor(credentialsDir?: string, cipher?: SecretCipher) {
    this.filePath = path.join(credentialsDir ?? DEFAULT_CREDENTIALS_DIR, FILENAME);
    this.cipher = cipher;
    this.load();
    this.migrateSubAgentDefaults();
    this.migrateProviderAccountsToRoutes();
    this.migrateAgentEnvKeysToRoutes();
    this.migrateRoutingSettingsKeys();
  }

  /**
   * docs/252 phase 2 — lift a top-level API key out of the single `agentEnv`
   * slot and into a credential route of the mode that names it.
   *
   * Today exactly one key travels this way: Codex's `OPENAI_API_KEY`, persisted
   * by `set_agent_env`. It is moved rather than copied, because leaving it in
   * both places is precisely the two-writers-one-fact drift this feature is
   * removing — and because `getAllAgentEnv()` feeds the agent env directly, so
   * a copy would keep being delivered from the old slot after the user removed
   * the credential.
   *
   * Matching is by the catalogue's `storageEnv` names, so a name the catalogue
   * does not claim (every `mcp__*` secret, anything a deployment set by hand)
   * is left exactly where it is.
   */
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
        // Already migrated (or configured through the new surface): the mode
        // holds a string credential, so the `agentEnv` copy is the stale one.
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

  /**
   * docs/252 phase 2 — lift docs/150's per-`AgentId` account rows into
   * `(service, billing mode)`-keyed credential routes.
   *
   * The mapping is forced, not chosen: an account row is a **subscription**
   * credential (metered keys were never accounts — they are the reserved env
   * routes), and the service is the harness's own vendor, because before this
   * feature a harness could reach nothing else. So `claude` → `(anthropic,
   * sub)` and `codex` → `(openai, sub)`, with `via: "account"` throughout.
   *
   * Runs once: the presence of `credentialRoutes` is the marker, so a later
   * boot never re-imports the frozen legacy blob and cannot resurrect an
   * account the user has since disconnected.
   */
  private migrateProviderAccountsToRoutes(): void {
    if (this.data.credentialRoutes) return;
    const legacy = this.data.providerAccounts;
    const routes: CredentialRoute[] = [];
    for (const [provider, accounts] of Object.entries(legacy ?? {})) {
      const serviceId = nativeServiceForHarness(provider as AgentId);
      // A provider with no catalogue service cannot be expressed as a route.
      // Dropping is wrong and inventing a service is worse, so leave the legacy
      // blob as the only record and say so — this is unreachable for the two
      // shipped harnesses, both of which declare a `nativeService`.
      if (!serviceId) {
        console.warn(
          `[credential-store] cannot migrate ${provider} accounts: no catalogue service for that harness`,
        );
        continue;
      }
      for (const account of accounts ?? []) {
        routes.push({ ...providerAccountToRoute(account, serviceId) });
      }
    }
    this.data.credentialRoutes = routes;
    this.save();
  }

  /**
   * docs/252 phase 2 — re-key the routing settings from `AgentId` to
   * `credentialModeKey(serviceId, billingMode)`.
   *
   * A legacy key is an `AgentId` and therefore contains no `:`, which is what
   * makes this both detectable and idempotent. The target is the *subscription*
   * mode of the harness's own vendor, for the same reason the account migration
   * above picks it: order, spreading and cutoffs only ever described a group of
   * subscription accounts.
   */
  private migrateRoutingSettingsKeys(): void {
    let changed = false;
    const rekey = <T>(map: Record<string, T> | undefined): Record<string, T> | undefined => {
      if (!map) return map;
      const next: Record<string, T> = {};
      // Two passes, so precedence never depends on JSON key order. An
      // already-migrated entry wins over a legacy one for the same group: a
      // mixed file can only arise from a rollback-and-re-upgrade, and there the
      // new-form key is the newer write.
      for (const [key, value] of Object.entries(map)) {
        if (key.includes(":")) next[key] = value;
      }
      for (const [key, value] of Object.entries(map)) {
        if (key.includes(":")) continue;
        const serviceId = nativeServiceForHarness(key as AgentId);
        if (!serviceId) continue; // an agent the catalogue does not carry; drop the setting rather than guess
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

  /**
   * docs/252 — bring a sub-agent default's model selection up to date: backfill
   * the `(serviceId, billingMode)` half, then move it off a retired model.
   *
   * `SubAgentDefaults.model` is the third persisted model selection and the
   * easiest to miss: the sub-agent spawn picks its credential route from
   * `subAgentId` *before* reading it, so once the same model id is reachable
   * through two services that bare string would silently resolve to the
   * harness's own vendor — the exact conflation this feature removes, surviving
   * in a corner.
   *
   * The bias is that same vendor, which is the frozen fact for any value written
   * before this feature: a harness could reach nothing else. A model id the
   * catalogue cannot place is left alone rather than given an invented service.
   *
   * **docs/252 phase 8** adds the second half. A sub-agent default is the third
   * persisted model selection and it strands on a retired model exactly as a
   * session does — the spawn would forward an id the CLI can no longer run
   * (req 13). `agentId` IS the harness the sub-agent spawns, which is what makes
   * the successor check well-defined here. It belongs in this pass rather than in
   * the getter because a retirement only ever arrives with a new catalogue, i.e.
   * with a new process: resolving at load covers every retirement exactly once,
   * where a writing getter would put a synchronous save behind every read.
   *
   * Runs at load and persists once, so it is a migration rather than a read-time
   * fill — a read-time fill would re-derive on every process and would not
   * survive into the settings payload the UI round-trips.
   */
  private migrateSubAgentDefaults(): void {
    const map = this.data.agentSubAgentDefaults;
    if (!map) return;
    let changed = false;
    for (const [agentId, defaults] of Object.entries(map)) {
      const modelId = defaults.model;
      if (!modelId) continue;
      let next = defaults;
      // The bias is the agent's own vendor, which is the frozen fact for any
      // value written before this feature: a harness could reach nothing else. A
      // model id the catalogue cannot place is left alone rather than given an
      // invented service — and a RETIRED id is one of those, which is why the
      // retirement pass below still has a bare-id branch to fall into.
      if (!next.serviceId) {
        const selection = resolveModelSelection(
          modelId,
          nativeServiceForHarness(agentId as AgentId),
        );
        if (selection) {
          next = { ...next, serviceId: selection.serviceId, billingMode: selection.billingMode };
        }
      }
      const successor =
        next.serviceId && next.billingMode
          ? retirementSuccessor(agentId as AgentId, {
              serviceId: next.serviceId,
              billingMode: next.billingMode,
              modelId,
            })
          : resolveRetiredModelId(
              agentId as AgentId,
              modelId,
              nativeServiceForHarness(agentId as AgentId),
            );
      if (successor) {
        next = {
          ...next,
          model: successor.modelId,
          serviceId: successor.serviceId,
          billingMode: successor.billingMode,
        };
      }
      if (next !== defaults) {
        map[agentId] = next;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch {
      // No file yet — fresh store. (Distinct from a decrypt/parse failure on an
      // existing file, which must NOT be swallowed; see below.)
      this.data = {};
      return;
    }

    const trimmed = raw.trim();
    if (isEncrypted(trimmed)) {
      if (!this.cipher) {
        // Encrypted file but encryption is disabled / the key is missing. Do
        // NOT fall through to the plaintext branch — JSON.parse would fail, the
        // store would reset to `{}`, and the next save() would overwrite the
        // real encrypted file with an empty one: a silent wipe. Fail closed.
        throw new Error(
          `[credential-store] ${this.filePath} is encrypted but no encryption ` +
            "key is configured. Provide SHIPIT_SECRET_KEY / restore the key file, " +
            "or run a deliberate decrypt-export before disabling encryption.",
        );
      }
      // Decrypt failures (wrong/rotated key, tampered file) MUST propagate:
      // swallowing them to `{}` would let the next save() overwrite the real
      // (still-encrypted) file with an empty store re-encrypted under the new
      // key — a silent wipe. Fail closed at boot instead.
      this.data = JSON.parse(this.cipher.decrypt(trimmed)) as CredentialData;
      return;
    }

    // Plaintext on disk: a legacy file (pre-encryption) or encryption disabled.
    // Tolerate parse errors here exactly as before (corrupt file ⇒ empty store).
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        this.data = parsed;
      }
    } catch {
      this.data = {};
      return;
    }

    // Re-encrypt a legacy plaintext file once, now, so it doesn't linger in
    // plaintext until the next settings change (one-shot at-rest migration).
    // Use the throwing write path: silently leaving plaintext on disk after the
    // operator opted into encryption would defeat the feature, so surface a
    // write failure rather than continuing.
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

  /**
   * Write the current data to disk (encrypted when a cipher is set). Throws on
   * any failure — callers decide whether to tolerate it. `chmod` after the
   * write repairs a pre-existing file whose mode is looser than 0600 (the
   * `writeFileSync` mode only applies when the file is created).
   */
  private writeToDisk(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const serialized = JSON.stringify(this.data, null, 2);
    const payload = this.cipher ? this.cipher.encrypt(serialized) : serialized;
    fs.writeFileSync(this.filePath, payload, { mode: 0o600 });
    fs.chmodSync(this.filePath, 0o600);
  }

  private save(): void {
    try {
      this.writeToDisk();
    } catch (err) {
      console.error("[credential-store] Failed to save:", getErrorMessage(err));
    }
  }

  // ---- Credential routes (docs/252 phase 2) ----

  /**
   * Every stored credential, optionally narrowed to one `(service, billing
   * mode)` pair. Storage order, not selection order — ordering by `priority`
   * and deriving `isPrimary` from position is `ProviderAccountManager.list()`'s
   * job (docs/150 req 19) and must stay in one place.
   */
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

  /**
   * Add or replace a credential route.
   *
   * docs/150 req 19 — no `isPrimary` invariant is maintained here. "Primary" is
   * position 0 of the `priority` order, derived on read; a second copy of that
   * fact is exactly what req 19 removed. A stale flag on disk is ignored.
   */
  upsertCredentialRoute(route: CredentialRoute): void {
    const routes = [...(this.data.credentialRoutes ?? [])];
    const idx = routes.findIndex((r) => r.id === route.id);
    const next = { ...route, updatedAt: Date.now() };
    if (idx >= 0) routes[idx] = next;
    else routes.push(next);
    this.data.credentialRoutes = routes;
    this.save();
  }

  /**
   * Remove a credential route **and its secret**, in that order in one write.
   * Splitting them would leave a secret with no record naming it, which nothing
   * would ever clean up.
   */
  deleteCredentialRoute(routeId: string): void {
    this.data.credentialRoutes = (this.data.credentialRoutes ?? []).filter((r) => r.id !== routeId);
    const secrets = { ...(this.data.credentialSecrets ?? {}) };
    if (routeId in secrets) {
      const { [routeId]: _removed, ...rest } = secrets;
      this.data.credentialSecrets = rest;
    }
    this.save();
  }

  /**
   * Add a route **and** its secret in one write.
   *
   * Two writes would leave a window in which a `ready` route exists with no
   * secret behind it — a credential that reports as configured and delivers
   * nothing. A crash there is unrecoverable by inspection, because the route
   * looks complete. One `save()` removes the window rather than documenting it.
   */
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

  /** The secret behind a `via: "string"` route. Server-side only. */
  getCredentialSecret(routeId: string): string | undefined {
    const value = this.data.credentialSecrets?.[routeId];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  setCredentialSecret(routeId: string, secret: string): void {
    this.data.credentialSecrets = { ...(this.data.credentialSecrets ?? {}), [routeId]: secret };
    this.save();
  }

  // ---- Provider accounts (docs/150) — a projection over credential routes ----
  //
  // docs/252 phase 2 makes `CredentialRoute` the storage shape and leaves these
  // four as the account-shaped view the docs/150 routing machinery still reads.
  // The projection is total and lossless in both directions: an account row IS
  // a `via: "account"` credential of its vendor's subscription mode, and
  // `provider` is recoverable from `serviceId` through the catalogue's
  // `nativeService`. Phase 3 — which moves eligibility and turn routing off
  // `AgentId` — is what deletes this pair of adapters; re-keying ~70 call sites
  // here would have bought nothing this phase can use.

  listProviderAccounts(provider?: AgentId): ProviderAccount[] {
    if (!provider) {
      return (["claude", "codex"] as AgentId[]).flatMap((id) => this.listProviderAccounts(id));
    }
    const serviceId = nativeServiceForHarness(provider);
    if (!serviceId) return [];
    return this.listCredentialRoutes(serviceId, "sub")
      .filter((route) => route.via === "account")
      .map((route) => routeToProviderAccount(route, provider));
  }

  getProviderAccount(provider: AgentId, accountId: string): ProviderAccount | undefined {
    return this.listProviderAccounts(provider).find((a) => a.id === accountId);
  }

  upsertProviderAccount(account: ProviderAccount): void {
    const serviceId = nativeServiceForHarness(account.provider);
    if (!serviceId) {
      throw new Error(`No catalogue service for provider ${account.provider}`);
    }
    this.upsertCredentialRoute(providerAccountToRoute(account, serviceId));
  }

  deleteProviderAccount(provider: AgentId, accountId: string): void {
    const route = this.getCredentialRoute(accountId);
    if (route?.via !== "account") return;
    if (route.serviceId !== nativeServiceForHarness(provider)) return;
    this.deleteCredentialRoute(accountId);
  }

  // ---- Agent environment variables ----

  getAgentEnv(key: string): string | undefined {
    return this.data.agentEnv?.[key];
  }

  /** Get all stored agent env vars. */
  getAllAgentEnv(): Record<string, string> {
    return { ...this.data.agentEnv };
  }

  setAgentEnv(key: string, value: string): void {
    this.data.agentEnv ??= {};
    this.data.agentEnv[key] = value;
    this.save();
  }

  // ---- MCP servers (docs/088-mcp-integration) ----

  /** Get a single MCP server config by name. */
  getMcpServer(name: string): McpServerConfig | undefined {
    return this.data.mcpServers?.[name];
  }

  /** Get all MCP server configs keyed by name. */
  getAllMcpServers(): Record<string, McpServerConfig> {
    return { ...this.data.mcpServers };
  }

  /** Add or replace an MCP server config. Enforces `config.name === name`. */
  setMcpServer(name: string, config: McpServerConfig): void {
    this.data.mcpServers ??= {};
    this.data.mcpServers[name] = { ...config, name };
    this.save();
  }

  /** Remove an MCP server config. Does NOT clear its `mcp__*` secrets. */
  deleteMcpServer(name: string): void {
    if (this.data.mcpServers) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by user-provided server name
      delete this.data.mcpServers[name];
      this.save();
    }
  }

  /**
   * Set the secret value behind a server's `$secret:` reference. `key` must be
   * in the `mcp__*` namespace — these are always agent-bound.
   */
  setMcpSecret(key: string, value: string): void {
    if (!key.startsWith("mcp__")) {
      throw new Error(`MCP secret key must start with "mcp__": ${key}`);
    }
    this.setAgentEnv(key, value);
  }

  /** Clear a single `mcp__*` secret value. */
  deleteMcpSecret(key: string): void {
    if (this.data.agentEnv && key in this.data.agentEnv) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by mcp__* secret name
      delete this.data.agentEnv[key];
      this.save();
    }
  }

  /** Clear every `mcp__<server>__*` secret for a given server name. */
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

  // ---- MCP OAuth tokens (docs/088 Phase 2) ----

  /**
   * Get the persisted OAuth tokens for a provider source id. The returned
   * object is a defensive copy so callers can mutate freely without
   * affecting the in-memory store.
   */
  getMcpOAuthTokens(source: string): OAuthTokens | undefined {
    const t = this.data.mcpOAuth?.[source];
    return t ? { ...t } : undefined;
  }

  /** Get all persisted MCP OAuth token entries as a fresh map copy. */
  getAllMcpOAuthTokens(): Record<string, OAuthTokens> {
    const out: Record<string, OAuthTokens> = {};
    for (const [k, v] of Object.entries(this.data.mcpOAuth ?? {})) {
      out[k] = { ...v };
    }
    return out;
  }

  /**
   * Persist OAuth tokens for a provider. Called after a successful exchange
   * or refresh. Stamps `obtainedAt` if the caller didn't provide one so the
   * UI can show "Connected 3 days ago".
   */
  setMcpOAuthTokens(source: string, tokens: OAuthTokens): void {
    this.data.mcpOAuth ??= {};
    this.data.mcpOAuth[source] = {
      ...tokens,
      obtainedAt: tokens.obtainedAt ?? new Date().toISOString(),
    };
    this.save();
  }

  /** Remove tokens for a single source ("disconnect"). */
  deleteMcpOAuthTokens(source: string): void {
    if (this.data.mcpOAuth && source in this.data.mcpOAuth) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by provider source id
      delete this.data.mcpOAuth[source];
      this.save();
    }
  }

  // ---- MCP OAuth registered clients (docs/139 — RFC 7591 DCR) ----

  /**
   * Get the dynamically-registered OAuth client for a provider source id.
   * Returned as a defensive copy. `undefined` when no client is registered
   * yet (first connect performs registration).
   */
  getMcpOAuthClient(source: string): McpOAuthRegisteredClient | undefined {
    const c = this.data.mcpOAuthClients?.[source];
    return c ? { ...c } : undefined;
  }

  /**
   * Persist a registered OAuth client for a provider. Called after a
   * successful RFC 7591 registration so subsequent connects reuse the same
   * `client_id`.
   */
  setMcpOAuthClient(source: string, client: McpOAuthRegisteredClient): void {
    this.data.mcpOAuthClients ??= {};
    this.data.mcpOAuthClients[source] = { ...client };
    this.save();
  }

  /**
   * Remove a registered client. Not called on "disconnect" (we keep the
   * client so reconnect skips re-registration); reserved for a future
   * "forget this provider entirely" affordance.
   */
  deleteMcpOAuthClient(source: string): void {
    if (this.data.mcpOAuthClients && source in this.data.mcpOAuthClients) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by provider source id
      delete this.data.mcpOAuthClients[source];
      this.save();
    }
  }

  // ---- GitHub token ----

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

  // ---- Linear credential (docs/170; team binding retired by docs/248 req 4) ----

  /** The stored Linear API token, or null when none is set. */
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

  /** Clear the Linear credential ("Disconnect Linear"). */
  clearLinear(): void {
    if (this.data.linear) {
      delete this.data.linear;
      this.save();
    }
  }

  // ---- Voice provider API keys (docs/144) ----

  /** The stored key for a voice provider id, or null when none is set. */
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

  /** Provider ids that currently have a non-empty key. */
  getConfiguredVoiceProviders(): string[] {
    return Object.entries(this.data.voiceProviderKeys ?? {})
      .filter(([, v]) => typeof v === "string" && v.trim())
      .map(([id]) => id);
  }

  // ---- Voice-note delivery (docs/163) ----

  /** The user's voice-note delivery mode. Defaults to "native". */
  getVoiceDeliveryMode(): VoiceDeliveryMode {
    const mode = this.data.voiceDeliveryMode;
    return mode === "native" || mode === "external" || mode === "both"
      ? mode
      : DEFAULT_VOICE_DELIVERY_MODE;
  }

  setVoiceDeliveryMode(mode: VoiceDeliveryMode): void {
    this.data.voiceDeliveryMode = mode;
    this.save();
  }

  /** The configured external webhook (url + bearer token), or null. */
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

  // ---- Max idle containers ----

  getMaxIdleContainers(): number {
    return this.data.maxIdleContainers ?? 5;
  }

  setMaxIdleContainers(n: number): void {
    this.data.maxIdleContainers = n;
    this.save();
  }

  // ---- Agent system instructions ----

  getAgentSystemInstructionsEnabled(): boolean {
    return this.data.agentSystemInstructionsEnabled ?? true;
  }

  setAgentSystemInstructionsEnabled(enabled: boolean): void {
    this.data.agentSystemInstructionsEnabled = enabled;
    this.save();
  }

  // ---- Auto-create PR ----

  getAutoCreatePr(): boolean {
    return this.data.autoCreatePr ?? false;
  }

  setAutoCreatePr(enabled: boolean): void {
    this.data.autoCreatePr = enabled;
    this.save();
  }

  // ---- Live steering ----

  // Defaults ON: the persistent streaming process is the only path that
  // handles interrupt-then-continue (AskUserQuestion answers, manual stop +
  // clarifying message) without re-sending an interrupted assistant turn
  // through `--resume`, which the API rejects once that turn carries signed
  // extended-thinking blocks ("thinking blocks ... cannot be modified", 400).
  // A user who explicitly turned it off keeps `false`; only the unset case
  // flips on. See docs/140.
  getLiveSteering(): boolean {
    return this.data.liveSteering ?? true;
  }

  setLiveSteering(enabled: boolean): void {
    this.data.liveSteering = enabled;
    this.save();
  }

  // ---- Proactive failover cutoffs (docs/150 reqs 4-6) ----

  /**
   * Cutoffs for one `(service, billing mode)`, defaulting to 90% on both
   * windows (req 5). Stored values are clamped on read as well as write, so a
   * hand-edited config that slipped an out-of-range number in cannot make the
   * selector behave nonsensically.
   */
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

  // ---- Account selection mode (docs/150 req 21) ----

  /**
   * Unrecognized stored values fall back to the default rather than being
   * surfaced: this is read on the turn-routing path, where an unknown mode has
   * no sensible behavior and failing the turn over a bad settings value would
   * be worse than routing the way an untouched install does.
   */
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

  // ---- Auto-resolve conflicts (docs/146) ----

  getAutoResolveConflicts(): boolean {
    return this.data.autoResolveConflicts ?? false;
  }

  setAutoResolveConflicts(enabled: boolean): void {
    this.data.autoResolveConflicts = enabled;
    this.save();
  }

  // ---- Auto-fix CI (docs/169) ----

  getAutoFixCi(): boolean {
    return this.data.autoFixCi ?? false;
  }

  setAutoFixCi(enabled: boolean): void {
    this.data.autoFixCi = enabled;
    this.save();
  }

  // ---- Auto-reset merged branch on continue (docs/218) ----

  // docs/218 Phase 3 — default ON. Resuming a merged, untouched session resets
  // the branch to the latest base before the turn (with the composer's per-send
  // opt-out + the settings toggle as the global escape hatch).
  getAutoResetMergedBranch(): boolean {
    return this.data.autoResetMergedBranch ?? true;
  }

  setAutoResetMergedBranch(enabled: boolean): void {
    this.data.autoResetMergedBranch = enabled;
    this.save();
  }

  // ---- Sub-agent spawning (docs/144) ----

  getEnableSubAgents(): boolean {
    return this.data.enableSubAgents ?? false;
  }

  setEnableSubAgents(enabled: boolean): void {
    this.data.enableSubAgents = enabled;
    this.save();
  }

  // ---- Sub-agent defaults (docs/217) ----

  /** Read the per-agent sub-agent defaults (empty object when unset). */
  getAgentSubAgentDefaults(agentId: string): SubAgentDefaults {
    return this.data.agentSubAgentDefaults?.[agentId] ?? {};
  }

  /** Read the full per-agent sub-agent-defaults map (for the settings payload). */
  getAllAgentSubAgentDefaults(): Record<string, SubAgentDefaults> {
    return { ...(this.data.agentSubAgentDefaults ?? {}) };
  }

  /**
   * Merge a partial sub-agent-defaults patch for one agent. An explicit `null`
   * (or `undefined`) for a field clears it, falling back to the CLI's own
   * default. A field absent from the patch is left unchanged.
   */
  setAgentSubAgentDefaults(
    agentId: string,
    patch: SubAgentDefaultsPatch,
    /**
     * docs/252 phase 3 — which `(service, mode)` the caller means, when it knows.
     *
     * `resolveModelSelection` picks the FIRST mode of the biased service, which
     * for Anthropic is `sub` — so on an install whose only Anthropic credential
     * is an API key, choosing Sonnet as a sub-agent default stored an
     * unreachable subscription triple and every consult then failed. The service
     * layer knows which modes are eligible; this lets it say so.
     *
     * A hint is a preference, not an override: it applies only when that mode
     * actually declares the model, so the stored triple still names a real
     * catalogue row and the invariant on {@link SubAgentDefaultsPatch} holds.
     */
    preferred?: { serviceId: string; billingMode: BillingMode },
  ): void {
    const current = { ...(this.data.agentSubAgentDefaults?.[agentId] ?? {}) };
    if ("reasoningEffort" in patch) {
      if (patch.reasoningEffort) current.reasoningEffort = patch.reasoningEffort;
      else delete current.reasoningEffort;
    }
    if ("model" in patch) {
      if (patch.model) current.model = patch.model;
      else delete current.model;
      // docs/252 — the service and mode belong to the model, so a model write
      // re-resolves them and a model clear drops them. Writing them independently
      // is what would let the stored triple name a row that does not exist.
      const hinted =
        patch.model && preferred
          ? modesOfferingModel(patch.model).find(
              (m) => m.serviceId === preferred.serviceId && m.billingMode === preferred.billingMode,
            )
          : undefined;
      const selection = patch.model
        ? (hinted
            ? { ...hinted, modelId: patch.model }
            : resolveModelSelection(patch.model, nativeServiceForHarness(agentId as AgentId)))
        : undefined;
      if (selection) {
        current.serviceId = selection.serviceId;
        current.billingMode = selection.billingMode;
      } else {
        delete current.serviceId;
        delete current.billingMode;
      }
    }
    // Rebuild the map (rather than `delete map[agentId]`) so a now-empty entry
    // drops out without a dynamic-delete.
    const next: Record<string, SubAgentDefaults> = {};
    for (const [id, value] of Object.entries(this.data.agentSubAgentDefaults ?? {})) {
      if (id !== agentId) next[id] = value;
    }
    if (Object.keys(current).length > 0) next[agentId] = current;
    this.data.agentSubAgentDefaults = next;
    this.save();
  }

  // ---- Utility ----

  /** Clear all stored credentials. */
  clear(): void {
    this.data = {};
    this.save();
  }
}

/**
 * docs/252 phase 2 — the two halves of the account↔route projection.
 *
 * Kept as free functions next to the store rather than as methods so they are
 * obviously pure and obviously each other's inverse, which is the property the
 * round-trip test asserts. Every field of `ProviderAccount` other than
 * `provider` survives verbatim — including the four that look like clutter and
 * are not: selection filters on `status` and `exhaustedUntil`, balanced routing
 * reads `lastUsedAt`, and duplicate detection and label adoption use
 * `externalId` and `labelIsGenerated`.
 */
export function providerAccountToRoute(account: ProviderAccount, serviceId: string): CredentialRoute {
  const { provider: _provider, ...rest } = account;
  return { ...rest, serviceId, billingMode: "sub", via: "account" };
}

export function routeToProviderAccount(route: CredentialRoute, provider: AgentId): ProviderAccount {
  const { serviceId: _serviceId, billingMode: _billingMode, via: _via, ...rest } = route;
  return { ...rest, provider };
}

/**
 * The `AgentId` an account-backed route belongs to, or `undefined` when the
 * service is not any harness's own vendor — which is every custom service, and
 * why this is the projection's only partial step.
 */
export function providerForRoute(route: CredentialRoute): AgentId | undefined {
  return harnessForNativeService(route.serviceId);
}

/**
 * docs/150 req 5 — a cutoff is a percentage, so anything outside 1–100 is
 * meaningless. Clamped rather than rejected: this runs on read as well as
 * write, and a config file that already holds a bad value should still yield a
 * working selector rather than throwing on every turn.
 */
function clampCutoff(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FAILOVER_CUTOFF;
  return Math.min(100, Math.max(1, Math.round(value)));
}
