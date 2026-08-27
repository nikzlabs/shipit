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
import { DEFAULT_VOICE_DELIVERY_MODE } from "../shared/types/voice-note-types.js";
import {
  allServices,
  getMode,
  nativeServiceForHarness,
  selectionExists,
  storageEnvFor,
} from "../shared/catalogue/index.js";
import type { BillingMode, ModelSelection } from "../shared/catalogue/index.js";

/**
 * docs/170 — the Linear **credential**, and nothing that identifies a
 * destination. `token` is a personal API key; the workspace it can reach is a
 * property of the key. Server-side only — the token is never echoed back to the
 * browser (status reports configured-or-not).
 *
 * docs/248-declared-issue-trackers req 4 — the stored `team` binding is gone. A Linear tracker's team is
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

/**
 * The pre-docs/252 account row, as it still sits in `credentials.json` on an
 * install that has not yet been through {@link
 * CredentialStore.migrateProviderAccountsToRoutes}.
 *
 * A **disk format**, not a domain type — which is why it is declared here and
 * not in `shared/types`. The live domain type it becomes is `CredentialRoute`;
 * planning#342 deleted the `ProviderAccount` interface that used to serve as
 * both, so the only thing that still needs this shape is the one-time read
 * below.
 */
interface LegacyProviderAccountRow extends Omit<CredentialRoute, "serviceId" | "billingMode" | "via"> {
  provider: AgentId;
}

/**
 * docs/264 — one role as it sits on disk.
 *
 * A **disk format**, not the domain type. Two differences from {@link AgentRole},
 * and both are deliberate:
 *
 *  - **the name is the key, not a field**, which is what makes req 18's
 *    uniqueness a property of the storage rather than a check something can
 *    forget;
 *  - **`params` is optional**, because the reserved reviewer key stores only its
 *    editable metadata. Its params are `{ kind: "auto" }` by synthesis, never by
 *    storage — writing them down would create the seed record req 2's "always
 *    present" is expressly built to avoid.
 *
 * `params` is the pinned shape only. `{ kind: "auto" }` is never stored for
 * anything, so it cannot be read back for a name that has no business having it.
 */
interface StoredRole {
  description?: string;
  prompt?: string;
  params?: RolePinnedParams;
}

interface CredentialData {
  agentEnv?: Record<string, string>;
  githubToken?: string;
  /** docs/170 — Linear Issues-tab binding. */
  linear?: LinearTrackerConfig;
  /**
   * docs/284 — the memory budget, in MB, for everything ShipIt runs. Absent
   * means "the host is the budget", which is the behaviour installs had before
   * this setting existed (req 9). Replaced `maxIdleContainers`: a container
   * count treated an idle shell and a Postgres service as equal claims on the
   * machine, which is what the user was actually rationing (req 3).
   */
  memoryBudgetMb?: number;
  agentSystemInstructionsEnabled?: boolean;
  autoCreatePr?: boolean;
  /**
   * When true, mid-turn messages are steered to the running agent instead of
   * queued. Capability-gated: only active when the agent also sets
   * supportsSteering: true. (docs/140)
   */
  liveSteering?: boolean;
  /**
   * docs/150-multiple-provider-subscriptions reqs 4–6 — proactive failover cutoffs.
   *
   * docs/252 phase 2 re-keys this (and {@link accountSelectionMode}) from
   * `AgentId` to `credentialModeKey(serviceId, billingMode)`. Both are answers
   * to "which of these credentials next?", a question that belongs to the group
   * a turn routes within — which is the `(service, billing mode)` pair, not the
   * CLI. Legacy `AgentId` keys are migrated once at load.
   */
  failoverCutoffs?: Record<string, FailoverCutoffs>;
  /** docs/150-multiple-provider-subscriptions req 21 — account selection mode, keyed as {@link failoverCutoffs}. */
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
   * docs/252 phase 7 (req 9) — the model the work ShipIt does OUTSIDE a turn
   * runs on: naming a session, writing a pull-request description.
   *
   * A `(service, billing mode, model)` selection like any other (req 3), chosen
   * independently of whatever any session is using. The harness is **derived**,
   * not stored — the first installed harness that model is offered on — so this
   * never grows a second control (`non-turn-model.ts`).
   *
   * **Absent is a state, not a missing value.** Unset means "the first model
   * this install can actually run", resolved fresh every time the work runs, so
   * it follows what the install has instead of pointing at a vendor the user
   * may never have used or has stopped paying for. Only a value the user
   * explicitly pinned can go stale, and that is the one req 9's failure notice
   * reports on.
   */
  nonTurnModel?: { serviceId: string; billingMode: BillingMode; modelId: string };
  /**
   * docs/261 (reqs 1, 4, 5, 8) — the two reviewers, as the user pinned them.
   *
   * **A slot holds either a pin or nothing, and nothing is a STATE.** Unset means
   * *auto-configured*, and the answer is derived at read time from the install as
   * it currently stands (`reviewer-model.ts`) — never written back here. That is
   * req 8's re-derivation: adding a second service, or a model from a family the
   * install did not have, improves the reviewer with no user action, no
   * migration and no staleness. A value written once at first run would freeze a
   * one-service install's answer in place, which is worst precisely where this
   * feature is aimed.
   *
   * A pin always wins. Nothing re-derives over a choice the user made.
   *
   * **Deliberately not seeded from the per-harness sub-agent defaults this
   * replaced.** Those values are dropped rather than migrated — a decision
   * recorded in `docs/261-configurable-reviewer/requirements.md`, whose whole
   * justification is the size of the install population. Anyone who had
   * configured one reconfigures the reviewer instead. The stored key is simply
   * never read again; nothing rewrites the file to remove it.
   */
  reviewers?: Partial<Record<ReviewerSlot, ReviewerPin>>;
  /**
   * docs/264 (reqs 1, 2, 6, 8, 9) — the user's agent roles, keyed by name.
   *
   * **Keyed by name is req 18's uniqueness rule**, held by the data rather than
   * checked: two roles cannot share a name because a map cannot hold the key
   * twice. There is no stored rank — {@link CredentialStore.getRoles} sorts at
   * read time, so the list is deterministic without an order to migrate — and no
   * rename primitive, because a rename is a validated write followed by a delete
   * and nothing holds a reference to the old name.
   *
   * **The reviewer is NOT a record here.** `getRoles()` synthesizes it from the
   * two `reviewers` pins above plus whatever editable metadata is stored under
   * its reserved key, so an empty store still contains it (req 2) with no seed,
   * no migration and no story for an install whose record was deleted before the
   * reserved-name rule existed. Its entry, when present, carries a description
   * and standing instructions and no `params` at all — its params are resolved,
   * never stored, which is exactly what makes them automatic.
   */
  roles?: Record<string, StoredRole>;
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
  providerAccounts?: Partial<Record<AgentId, LegacyProviderAccountRow[]>>;
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
  /**
   * docs/257 req 9 — when harness onboarding was first *completed*, as an ISO
   * timestamp. Absent means "never".
   *
   * Req 9 asks a question about the install's **history**, and every other
   * signal in this file describes the present: disconnecting deletes the
   * record, so "completed and then removed everything" and "never configured"
   * are otherwise the same bytes. This field is the only thing that tells them
   * apart, which is why it is written once and never cleared — a user who sets
   * ShipIt up and later removes every credential is not a new user and does not
   * get the onboarding panel back.
   *
   * Install-global rather than per-session, and server-side rather than
   * `localStorage`, so a second browser and a second repository see the same
   * answer.
   */
  harnessOnboardingCompletedAt?: string;
  /**
   * docs/252 req 20 — what `adoptEnvCredentials` has done with each catalogue
   * `storageEnv` the deployment set, keyed by the variable's name.
   *
   * Two facts, and both are about *history*, which is why neither can be
   * derived from the route list at boot:
   *
   * - `importedValue` is the exact secret adoption last wrote. It answers "is
   *   this row still ours?" — a rotation may overwrite a value adoption put
   *   there, and must not overwrite one the user replaced by hand. A boolean
   *   "was adopted" flag cannot tell those apart, because it records how the
   *   row *started*.
   * - `removed` says the user deleted the adopted row. The variable is still
   *   set in the deployment, so without this the next boot re-imports it and
   *   the removal silently never happens.
   *
   * Server-side only, and it holds a secret (`importedValue`), so it lives here
   * beside `credentialSecrets` rather than anywhere a route list is returned.
   */
  adoptedEnvCredentials?: Record<string, { importedValue?: string; removed?: boolean }>;
}

/**
 * docs/264-agent-roles req 18 — "no length limit beyond what storage needs". These are that
 * limit and nothing narrower.
 *
 * They exist because the credentials file is read whole into memory on every
 * load, so an unbounded field is a way to make the store unreadable. They are
 * **pathological-write guards, not product rules**, and the numbers are chosen
 * so: no name, summary or standing brief a human would type comes near one. An
 * earlier draft capped a name at 200, which cross-agent review correctly called
 * a rule req 18 does not permit — JSON has no such boundary, so 200 was a
 * product decision wearing a storage justification.
 *
 * The prompt's bound is also the *stored* half of the pair the plan describes:
 * the combined prompt is checked again against the destination's own limit after
 * the join, which is phase 3's.
 */
export const MAX_ROLE_NAME_LENGTH = 10_000;
export const MAX_ROLE_DESCRIPTION_LENGTH = 500;
export const MAX_ROLE_PROMPT_LENGTH = 20_000;

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
      for (const { provider: _provider, ...rest } of accounts ?? []) {
        // Every other field survives verbatim — including the four that look
        // like clutter and are not: selection filters on `status` and
        // `exhaustedUntil`, balanced routing reads `lastUsedAt`, and duplicate
        // detection and label adoption use `externalId` and `labelIsGenerated`.
        routes.push({ ...rest, serviceId, billingMode: "sub", via: "account" });
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

  // ---- Harness onboarding completion (docs/257 req 9) ----

  /** When harness onboarding was first completed, or `undefined` for never. */
  getHarnessOnboardingCompletedAt(): string | undefined {
    const value = this.data.harnessOnboardingCompletedAt;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  /**
   * Record that harness onboarding is complete, **only if it is not already**,
   * and only if the write actually reaches disk. Returns the stamp in force
   * afterwards, or `undefined` when nothing was recorded.
   *
   * **This deliberately does not go through {@link save}.** `save()` catches
   * write failures and returns normally, which is the right trade for a
   * preference that can be re-set — but req 9 says the onboarding panel never
   * comes back, so a stamp that lives only in memory would report "completed"
   * for the rest of the process, vanish at the next restart, and return the
   * panel to a user who finished onboarding months earlier. That is a
   * requirement violation which looks like a bug and has no trace.
   *
   * So a failed write is reverted in memory too and reported as *not yet*
   * completed: the panel staying up one more session is a harmless repeat of a
   * correct ask, where a silently lost stamp is not.
   */
  stampHarnessOnboardingCompleted(at: string): string | undefined {
    const existing = this.getHarnessOnboardingCompletedAt();
    if (existing) return existing;
    this.data.harnessOnboardingCompletedAt = at;
    try {
      this.writeToDisk();
    } catch (err) {
      delete this.data.harnessOnboardingCompletedAt;
      console.error(
        "[credential-store] Failed to record harness onboarding completion:",
        getErrorMessage(err),
      );
      return undefined;
    }
    return at;
  }

  // ---- Credential routes (docs/252 phase 2) ----

  /**
   * Every stored credential, optionally narrowed to one `(service, billing
   * mode)` pair. Storage order, not selection order — ordering by `priority`
   * and deriving `isPrimary` from position is `ProviderAccountManager.list()`'s
   * job (docs/150-multiple-provider-subscriptions req 19) and must stay in one place.
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
   * docs/150-multiple-provider-subscriptions req 19 — no `isPrimary` invariant is maintained here. "Primary" is
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
    // planning#358 — a replaced secret is a new credential, so the previous
    // one's `auth_failed` verdict no longer describes it. Clearing here (rather
    // than only on a successful turn) is what makes "paste a fresh token" a
    // complete remedy: the row returns to `ready` immediately, instead of
    // keeping the warning until the user happens to run a turn. Re-saving an
    // identical value also clears, which is the intended reading of "let me try
    // this again" and self-corrects on the next failure.
    //
    // Written inline rather than via `upsertCredentialRoute` so one `save()`
    // persists the secret and the status together — this is the only caller
    // that needs that, since the Settings editor path calls
    // `upsertCredentialRoute` itself immediately afterwards. It is also the only
    // place in this store that hand-rolls the row update, so an invariant added
    // to `upsertCredentialRoute` later must be mirrored here.
    const route = this.getCredentialRoute(routeId);
    if (route?.via === "string" && route.status === "auth_failed") {
      this.data.credentialRoutes = (this.data.credentialRoutes ?? []).map((r) =>
        r.id === routeId ? { ...r, status: "ready" as const, updatedAt: Date.now() } : r,
      );
    }
    this.save();
  }

  /** docs/252 req 20 — see {@link CredentialData.adoptedEnvCredentials}. */
  getAdoptedEnvCredential(storageEnv: string): { importedValue?: string; removed?: boolean } | undefined {
    return this.data.adoptedEnvCredentials?.[storageEnv];
  }

  /**
   * Record what adoption did with one variable. Merges rather than replaces, so
   * marking a removal cannot drop the `importedValue` that says the row was
   * ours — and re-importing after a rotation cannot drop a `removed` flag.
   */
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

  /**
   * docs/252 phase 5, req 12 — bench a **subscription** credential until `until`
   * (epoch ms), so routing stops choosing the one that just refused a turn.
   *
   * The string-delivered twin of `ProviderAccountManager.markAccountExhausted`,
   * and it shares that method's two rules for the same reasons: the NEWEST
   * refusal's stated reset wins outright (docs/260-turn-level-account-routing req 9 — a re-probe saying
   * "resets in five minutes" must supersede an older week-long estimate, and
   * `refusalBlockedUntil`'s 30-minute cap bounds the cost of the reverse
   * direction); and a `key` route is silently ignored, because metered billing
   * has no subscription window to exhaust and req 12 forbids failing a key
   * over anyway.
   *
   * Returns the stamped route, or `null` when there was nothing to stamp — an
   * unknown id, or a `key` credential.
   */
  markCredentialRouteExhausted(routeId: string, until: number): CredentialRoute | null {
    const route = this.getCredentialRoute(routeId);
    if (route?.billingMode !== "sub") return null;
    // docs/260-turn-level-account-routing req 9 — every refusal refreshes the observation clock:
    // `refusalBlockedUntil` reads `min(until, at + cap)`, and a row without
    // the clock reads as expired. Before 260 this stamp never wrote
    // `exhaustedAt`, which is why string credentials had no recovery path at
    // all (req 11).
    this.upsertCredentialRoute({
      ...route,
      exhaustedUntil: until,
      exhaustedAt: Date.now(),
    });
    return this.getCredentialRoute(routeId) ?? null;
  }

  /**
   * docs/260-turn-level-account-routing req 9 — the string-delivered twin of
   * `ProviderAccountManager.clearRefusalOnHealthyReading`: a reading newer
   * than the refusal whose known windows are all below 100% clears the memory.
   */
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
      // Same rule as the account twin: a window that has rolled over is not
      // evidence, so it cannot hold the refusal open.
      if (!subscriptionWindowIsCurrent(window, now)) continue;
      if (typeof window?.usedPct === "number" && window.usedPct >= 100) return false;
    }
    this.upsertCredentialRoute({ ...route, exhaustedUntil: null, exhaustedAt: null });
    return true;
  }

  /**
   * docs/150-multiple-provider-subscriptions req 21 — stamp the credential a turn actually resolved onto, which
   * is what the `balanced` selection mode sorts by. The string-delivered twin of
   * `ProviderAccountManager.markAccountUsed`.
   */
  markCredentialRouteUsed(routeId: string): void {
    const route = this.getCredentialRoute(routeId);
    if (!route) return;
    this.upsertCredentialRoute({ ...route, lastUsedAt: Date.now() });
  }

  /**
   * planning#358 — record that a turn on this **string-delivered** credential
   * was refused for authentication, so the row stops reading `ready`.
   *
   * The string-delivered twin of `markProviderAccountUnauthenticated`, and the
   * gap that issue names: an account reaches `auth_failed` because a sign-in
   * flow reports one, and a supplied secret has no sign-in flow at all — so a
   * token that is stale, revoked or simply wrong stayed `ready` forever while
   * every turn on it died. `turn-executor` already classifies exactly this case
   * (`capturedCredentialRoute` present and not an account ⇒ `healed = false`,
   * "a bad API key or env token is not something the account refresher owns");
   * this is that verdict written down instead of discarded.
   *
   * **Deliberately does NOT bench the route, and the asymmetry with the account
   * twin is the point rather than an oversight.** `listConfiguredCredentials`
   * excludes a non-`ready` **account** and reads `status` for nothing else, so a
   * string row marked here stays selectable.
   *
   * That has to be true for the mark to be safe at all: this state's recovery is
   * *proof by use*, so excluding the route would deadlock it — a credential the
   * router will not select can never run the turn that clears it, and one
   * transient provider 401 would strand a good credential permanently. The
   * account twin can afford exclusion only because its recovery is a sign-in
   * flow, which does not depend on being selected.
   *
   * The time-boxed bench on the set-aside path remains the mechanism for "stop
   * using this for a while"; this is only the row telling the truth about
   * itself.
   *
   * Accounts are ignored rather than handled here: they have their own
   * mark/clear pair on `ProviderAccountManager`, and two writers for one row is
   * how the two disagree.
   *
   * Returns true when it changed the row, so callers can skip a redundant
   * broadcast.
   */
  markCredentialRouteAuthFailed(routeId: string): boolean {
    const route = this.getCredentialRoute(routeId);
    if (route?.via !== "string" || route.status === "auth_failed") return false;
    this.upsertCredentialRoute({ ...route, status: "auth_failed" });
    return true;
  }

  /**
   * planning#358 — recovery counterpart to
   * {@link markCredentialRouteAuthFailed}, and the reason that one is safe to
   * write at all.
   *
   * `markProviderAccountReauthenticated`'s docstring records what happens
   * without a clear path: a row marked once "stays stuck `auth_failed` forever"
   * while the credential works again, so the panel keeps demanding attention
   * nothing needs. A supplied secret has two ways back and both call this — a
   * turn that authenticates on the route (proof by use), and a replaced secret
   * (`setCredentialSecret`, a fresh value deserving a fresh verdict).
   *
   * Idempotent: a no-op unless the row is actually `auth_failed`, so the
   * every-turn success path costs a read and no write.
   */
  clearCredentialRouteAuthFailed(routeId: string): boolean {
    const route = this.getCredentialRoute(routeId);
    if (route?.via !== "string" || route.status !== "auth_failed") return false;
    this.upsertCredentialRoute({ ...route, status: "ready" });
    return true;
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

  // ---- Linear credential (docs/170; team binding retired by docs/248-declared-issue-trackers req 4) ----

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

  // ---- Memory budget (docs/284) ----

  /** The configured budget in MB, or `null` for "the host is the budget". */
  getMemoryBudgetMb(): number | null {
    const v = this.data.memoryBudgetMb;
    return typeof v === "number" && v > 0 ? v : null;
  }

  /** Pass `null` (or a non-positive number) to clear the budget. */
  setMemoryBudgetMb(mb: number | null): void {
    if (mb === null || !Number.isFinite(mb) || mb <= 0) {
      delete this.data.memoryBudgetMb;
    } else {
      this.data.memoryBudgetMb = Math.floor(mb);
    }
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

  // ---- Proactive failover cutoffs (docs/150-multiple-provider-subscriptions reqs 4-6) ----

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

  // ---- Account selection mode (docs/150-multiple-provider-subscriptions req 21) ----

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
    return this.data.enableSubAgents ?? true;
  }

  setEnableSubAgents(enabled: boolean): void {
    this.data.enableSubAgents = enabled;
    this.save();
  }

  // ---- Non-turn work's model (docs/252 phase 7, req 9) ----

  /**
   * The model non-turn work runs on, or `undefined` when this install has not
   * been given one yet — see {@link CredentialData.nonTurnModel}.
   *
   * **`undefined` is a bootstrap state, not a user-facing one** (2026-08-13).
   * It used to mean "follow the install", a second state the UI had to name and
   * could not; `seedNonTurnModel` now writes a value the first time the install
   * can run something, so the only readers who see `undefined` are the ones
   * running before that first write. `resolveNonTurnModel` still answers them
   * with the first eligible model — the same one the seed goes on to store.
   *
   * Deliberately NOT resolved here: which harness runs it is derived where the
   * work runs (`non-turn-model.ts`).
   */
  getNonTurnModel(): ModelSelection | undefined {
    const stored = this.data.nonTurnModel;
    if (!stored) return undefined;
    // A pin naming no catalogue row is not a pin — it is the state phase 1's
    // invariant forbids ("a stored selection either names a real catalogue row,
    // or carries no service and mode at all"). Reading it as unset degrades to
    // the derived default rather than to a triple nothing can resolve.
    //
    // A **retired** model is not that state. It named a real row when it was
    // written and the catalogue still carries its retirement record, so req 13
    // has a successor to move it to — and `resolveNonTurnModel` is where that
    // resolution lives. Refusing it here made that whole path unreachable: the
    // pin read as unset, the derived default silently took over, and the user's
    // choice was discarded by a retirement rather than followed through it.
    // Found by cross-backend review.
    if (selectionExists(stored)) return { ...stored };
    const retired = getMode(stored.serviceId, stored.billingMode)
      ?.retired.some((r) => r.id === stored.modelId);
    return retired ? { ...stored } : undefined;
  }

  /** Pin non-turn work to a selection, or clear the pin with `null`. */
  setNonTurnModel(selection: ModelSelection | null): void {
    if (selection === null) {
      delete this.data.nonTurnModel;
      this.save();
      return;
    }
    if (!selectionExists(selection)) {
      throw new Error(
        `No catalogue entry for ${selection.serviceId}/${selection.billingMode}/${selection.modelId}`,
      );
    }
    this.data.nonTurnModel = { ...selection };
    this.save();
  }

  /**
   * docs/252 req 9 — **write the setting once, and only if the write lands.**
   *
   * What `setNonTurnModel` cannot give the seed, found by cross-backend review:
   * **a failed write must not linger in memory.** `save()` logs and swallows, so
   * a full or read-only credentials directory would leave the process reporting
   * a stored setting that vanishes on restart — and, if the install's services
   * changed meanwhile, seeds a *different* model next boot with no user action.
   * Rolling the field back means the next read simply tries again, which is the
   * same bargain {@link stampHarnessOnboardingCompleted} strikes one field over.
   *
   * The check lives here too, so a caller cannot forget it — but **not** as a
   * concurrency guard, and an earlier version of this comment claimed otherwise.
   * Node runs one request at a time and neither this nor the caller's own
   * check-then-write yields, so there was never a window between them for a
   * concurrent PUT to slip into. The second review round was right to strike
   * that claim.
   *
   * @returns what the setting holds afterwards — the existing value if there
   *   was one, the written value on success, `undefined` when the write failed.
   */
  stampNonTurnModel(selection: ModelSelection): ModelSelection | undefined {
    const existing = this.getNonTurnModel();
    if (existing) return existing;
    if (!selectionExists(selection)) {
      throw new Error(
        `No catalogue entry for ${selection.serviceId}/${selection.billingMode}/${selection.modelId}`,
      );
    }
    this.data.nonTurnModel = { ...selection };
    try {
      this.writeToDisk();
    } catch (err) {
      delete this.data.nonTurnModel;
      console.error(
        "[credential-store] Failed to record the background-work model:",
        getErrorMessage(err),
      );
      return undefined;
    }
    return { ...selection };
  }

  // ---- The two reviewers (docs/261, reqs 1, 4, 5, 8) ----

  /**
   * The user's pin for one reviewer slot, or `undefined` for *auto-configured*.
   *
   * Deliberately NOT resolved here, for the same reason {@link getNonTurnModel}
   * is not: the derived answer is a rule evaluated where the review runs
   * (`reviewer-model.ts`), so pinned and auto-configured stay distinguishable
   * all the way to the UI — which is exactly what req 8's *visible* state needs.
   *
   * A pin naming no catalogue row reads as unset, degrading to the derived
   * default rather than to a triple nothing can resolve (docs/252 phase 1's
   * invariant: a stored selection either names a real row, or carries no service
   * and mode at all). A **retired** model is not that state — it named a real row
   * when it was written and req 13 has a successor to move it to, so it is
   * returned and `reviewer-model.ts` resolves it through the retirement. Reading
   * it as unset here would discard the user's choice on a retirement instead of
   * following it through one.
   */
  getReviewerPin(slot: ReviewerSlot): ReviewerPin | undefined {
    const stored = this.data.reviewers?.[slot];
    if (!stored) return undefined;
    if (selectionExists(stored)) return { ...stored };
    const retired = getMode(stored.serviceId, stored.billingMode)?.retired.some(
      (r) => r.id === stored.modelId,
    );
    return retired ? { ...stored } : undefined;
  }

  /** Both slots as stored, for the settings payload. */
  getReviewerPins(): Partial<Record<ReviewerSlot, ReviewerPin>> {
    const out: Partial<Record<ReviewerSlot, ReviewerPin>> = {};
    for (const slot of REVIEWER_SLOTS) {
      const pin = this.getReviewerPin(slot);
      if (pin) out[slot] = pin;
    }
    return out;
  }

  /**
   * Pin a reviewer slot, or return it to auto-configuration with `null`.
   *
   * The whole tuple is written at once because pinning is atomic (req 8): a
   * pinned effort over a derived model would be a slot that silently re-derives
   * half of itself when a service is added, so it is not expressible — which
   * {@link ReviewerPin} states in the type and this only enforces on the value.
   *
   * The effort is checked for presence and not against the harness's own level
   * set: the harness is derived from the model and can differ per review (it
   * avoids the implementer's), so this store cannot know which set applies. A
   * level the harness rejects is the harness's error to report — the corollary
   * docs/252 already recorded for reasoning being a harness property.
   */
  setReviewerPin(slot: ReviewerSlot, pin: ReviewerPin | null): void {
    // Rebuild the map (rather than `delete current[slot]`) so clearing a slot
    // drops it without a dynamic-delete.
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
      // An ABSENT level is legal — a harness declaring none has nothing to pin
      // (docs/274 req 8). Whether absence is correct for *this* pin depends on
      // the harness the model derives to, which this store cannot resolve; that
      // check is `resolveReviewerPinPatch`'s, at the service layer. What is
      // checkable here is that a level, if given, says something.
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

  // ---- Agent roles (docs/264, reqs 1, 2, 6, 8, 9, 18) ----

  /**
   * Every role this install has, sorted by name — **the reviewer always among
   * them** (req 2).
   *
   * Sorted at read time rather than stored in an order: there is no reorder
   * control and no default-role flag, so a stored rank would be state to migrate
   * for a list that has one correct order anyway.
   *
   * **The reviewer is synthesized, not stored.** Seeding a record at first run
   * would need a migration, an idempotent upgrade path and a story for an
   * install whose record was deleted before the reserved-name rule existed.
   * Building it here needs none of those, and an empty store still contains it
   * because the store is not where it comes from — its params are always
   * `{ kind: "auto" }`, and only its description and standing instructions are
   * read from disk.
   *
   * Sorting is `localeCompare`, because req 18 lets a name be anything a user
   * types and code-point order would scatter accented and non-Latin names.
   */
  getRoles(): AgentRole[] {
    const stored = this.data.roles ?? {};
    const out: AgentRole[] = [];
    for (const [name, role] of Object.entries(stored)) {
      // A stored entry with no params is metadata for the reserved name; it is
      // not a pinned role, and returning one as if it were would produce a role
      // with nothing to run.
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

  /** One role by its exact name, reviewer included. `undefined` for a name nobody created. */
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

  /**
   * Upsert a role, or delete it with `null`.
   *
   * One primitive for both, and no rename: a rename is this write under the new
   * name followed by this delete under the old one, and an atomic version would
   * only be worth building if something held a reference to the name. Nothing
   * does.
   *
   * What is refused, and why each is a caller bug rather than a state to store:
   *
   *  - **a name that is blank once whitespace is discounted**, or one longer
   *    than {@link MAX_ROLE_NAME_LENGTH}. Req 18 allows any name the user types
   *    with only uniqueness enforced, so there is no token shape and no case
   *    rule — and, since cross-agent review, **no normalization either**: the
   *    name is stored EXACTLY as typed. An earlier draft stored `name.trim()`,
   *    which quietly made `" deep dive "` into `"deep dive"` and, worse, turned
   *    `" reviewer "` into the reserved name. Trimming survives only as the test
   *    for blankness, which is a different thing from rewriting the key;
   *  - **`{ kind: "auto" }` under any name but the reserved one.** The
   *    discriminator exists to describe the one role whose params ShipIt
   *    resolves, not to offer a state nobody can reach — an ordinary role set to
   *    `auto` would have no params and no way to acquire any;
   *  - **pinned params under the reserved name, and deleting it at all.** The
   *    reviewer cannot be renamed or deleted (req 2), and its params are
   *    resolved rather than pinned. Its description and standing instructions
   *    *are* editable, which is what a write to that name is for.
   *
   * The params themselves are **not** validated here against the catalogue.
   * That is `services/roles.ts`'s `validateRolePinnedParams`, which needs the
   * install's credentials — a store that reached for those would be deciding a
   * policy question, and a role would become unsaveable from a test that has no
   * credentials wired. It is the same division `setReviewerPin` already makes,
   * where `resolveReviewerPinPatch` validates at the settings layer.
   *
   * **So req 6's "a role whose harness cannot run its model is refused when it
   * is saved" is not yet true end to end, and that is the phase boundary rather
   * than a gap.** Phase 1 owns the validator; connecting it to a write is phase
   * 2's own checklist bullet ("Role CRUD through the existing settings mutation
   * surface, validated by the harness-explicit validator above"). Nothing calls
   * this method in production yet, so no user action can persist an invalid
   * role in the meantime — but a phase-3 or phase-2 caller that writes through
   * here **must** validate first, and this is the notice that it is not done for
   * it.
   */
  setRole(name: string, role: AgentRole | null): void {
    // Blankness is the only thing trimming decides. The stored key is `name`
    // itself, so a name the user typed with spaces round it stays that name.
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
        // The reserved name stores metadata only — see `StoredRole`.
        ...(role.params.kind === "pinned" ? { params: { ...role.params } } : {}),
      },
    };
    this.save();
  }

  /** The reviewer as a role: automatic params, plus whatever metadata was stored under its key. */
  private reviewerRole(): AgentRole {
    const stored = this.data.roles?.[RESERVED_ROLE_NAME];
    return {
      name: RESERVED_ROLE_NAME,
      ...(stored?.description ? { description: stored.description } : {}),
      ...(stored?.prompt ? { prompt: stored.prompt } : {}),
      params: { kind: "auto" },
    };
  }

  // ---- Utility ----

  /** Clear all stored credentials. */
  clear(): void {
    this.data = {};
    this.save();
  }
}

/**
 * docs/150-multiple-provider-subscriptions req 5 — a cutoff is a percentage, so anything outside 1–100 is
 * meaningless. Clamped rather than rejected: this runs on read as well as
 * write, and a config file that already holds a bad value should still yield a
 * working selector rather than throwing on every turn.
 */
function clampCutoff(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FAILOVER_CUTOFF;
  return Math.min(100, Math.max(1, Math.round(value)));
}
