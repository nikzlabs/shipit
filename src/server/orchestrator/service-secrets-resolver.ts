/**
 * ServiceSecretsResolver — owns the secret-reconciliation slice of the
 * compose stack lifecycle.
 *
 * Extracted from `service-manager.ts` so the manager doesn't need to know
 * about MCP loaders, env-file vs Docker-secrets delivery, or sweep
 * semantics. The manager calls `sync(parsedServices)`
 * before each `compose up` (initial start, reconcile, `refreshSecrets`),
 * subscribes to snapshot updates via the `onSnapshot` callback, and reads
 * the resulting Docker-secrets build metadata back via
 * `getDockerSecretsBuild()` when generating the compose override.
 */

import {
  resolveSecrets,
  renderAgentEnvBody,
  writeServiceEnvFilesToRoot,
  writeAgentEnvFile,
  writeIsolatedSecretFiles,
  composeSecretFilePath,
  stageSecretsEntrypoint,
  type DeclaredSecret,
} from "./secret-resolver.js";
import type { ComposeService } from "./compose-generator.js";
import {
  pluginClaimantsOf,
  pluginCredentialNames,
  resolvePluginCredentials,
  satisfiedCredentialNames,
  type PluginCredentialDeclaration,
  type PluginCredentialGroup,
} from "../shared/plugin-credentials.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretsStatusSnapshot {
  /**
   * All declared secrets, de-duplicated by name: every `x-shipit-secrets`
   * entry across all services, plus every credential name an activated plugin
   * declares (docs/262 req 23). A name claimed by both is ONE entry carrying
   * both claimant lists — it is one stored secret.
   */
  declared: DeclaredSecret[];
  /** Service-name → list of declared secrets that have no value (required + optional). */
  missingByService: Record<string, string[]>;
  /** Names of required secrets that have no value, de-duplicated. */
  missingRequired: string[];
  /**
   * Names of secrets marked `agent: true` that have a resolved value.
   * Used by the runner to push them into the agent container's process.env.
   * Values themselves are exposed via {@link agentValues} on the snapshot
   * the runner consumes — kept off this public type to avoid leaking
   * secret values into telemetry / logs.
   */
  agentNames: string[];
  /**
   * docs/262 req 23 — plugin-declared credential needs, GROUPED per activated
   * plugin rather than flattened into `declared`. The grouping is the
   * requirement: a missing key has to read as "the `artk` plugin needs
   * `FAL_KEY`", which a flat name list cannot say.
   *
   * Deliberately NOT folded into `missingRequired`: that list drives the
   * preview's "configure secrets to run this project" banner, which is about
   * the project's own services failing to start. A plugin's gap is reported
   * where the plugin is — on its card in the Plugins tab, and as a claimant on
   * the settings row — and does not block the project's preview.
   */
  plugins: PluginCredentialGroup[];
}

/**
 * Internal snapshot variant — same as {@link SecretsStatusSnapshot} plus the
 * resolved `agent: true` values that subscribers (the runner) need to push
 * into the agent container.
 *
 * Kept as a separate type so the public-facing snapshot doesn't include
 * raw secret values.
 */
export interface SecretsStatusInternalSnapshot extends SecretsStatusSnapshot {
  /** Resolved key-value pairs for `agent: true` entries. */
  agentValues: Record<string, string>;
}

/**
 * Per-secret file references for the most recent compose override. Built
 * inside `sync()` and consumed by `generateComposeOverride()`. Only set
 * when Docker-secrets mode is active.
 */
export interface DockerSecretsBuild {
  secretNames: string[];
  perService: Record<string, string[]>;
  filePathFor: (name: string) => string;
  /**
   * planning#287 — compose-side (daemon-visible) absolute path of the staged
   * entrypoint wrapper, or `undefined` when staging failed. The override
   * bind-mounts it into each secret-consuming service container; a service is
   * left without the wrapper (and therefore without its env vars) rather than
   * pointed at a path that doesn't exist.
   */
  entrypointHostPath?: string;
}

export interface DockerSecretsConfig {
  internalDir: string;
  hostDir?: string;
  entrypointSourcePath: string;
}

export interface ServiceSecretsResolverOptions {
  sessionId: string;
  workspaceDir: string;
  secretsLoader?: () => Promise<Record<string, string>>;
  accountAgentEnvLoader?: () => Record<string, string>;
  dockerSecretsConfig?: DockerSecretsConfig;
  /**
   * docs/183 — orchestrator-private root for per-service env files, OUTSIDE the
   * session workspace. Unless Docker-secrets mode is active, service env files
   * are written to `<serviceEnvDir>/<sessionId>/.env.<svc>` and the compose
   * override references those absolute paths via `env_file:`.
   *
   * **Required** (planning#292). It used to be optional, and omitting it fell back to
   * writing `.shipit/.env.<svc>` into the agent-readable git clone — the last
   * in-clone writer in the codebase (docs/246-shipit-state-out-of-clone req 7). Production never took that
   * branch (`bootstrap-managers.ts` always computes a root, defaulting to
   * `<stateDir>/service-env`), so only tests reached it; requiring the option
   * makes "service secrets never land in the clone" a property of the type
   * rather than of the wiring.
   */
  serviceEnvDir: string;
  /**
   * Called after every `sync()` pass. Receives a *defensive copy* of the
   * latest snapshot so the resolver and its subscribers don't share mutable
   * state.
   */
  onSnapshot?: (snapshot: SecretsStatusInternalSnapshot) => void;
  /**
   * docs/184 — surface a one-line notice (per service) when a compose entry
   * still declares a now-unhonored `source: platform:*` field. Wired to the
   * service-log broadcast so the user learns to set a user secret instead.
   * De-duplicated per (service, name, source) for the resolver's lifetime so
   * reconciles don't spam the log.
   */
  onPlatformSourceWarning?: (serviceName: string, text: string) => void;
  /**
   * docs/262 req 23 — what the session's activated plugins declare they need,
   * read fresh on each sync (a `shipit.yaml` edit or a plugin refresh changes
   * the answer, and there is nothing to invalidate).
   *
   * Only the NAMES arrive here. Satisfaction is decided inside {@link sync}
   * against the very same `userSecrets` map the compose services resolve
   * from — the consuming project's own secret store — so a plugin credential
   * can never resolve from a source a project credential could not. That is
   * req 23's platform-credential boundary, held by sharing one input rather
   * than by a second lookup that could drift.
   */
  pluginCredentialsLoader?: () => PluginCredentialDeclaration[];
}

/**
 * docs/262 req 23 — one surfaced plugin service, as the secrets pass needs it:
 * the name it is addressed by, and the credential names its plugin declared in
 * the LIVE manifest the fragment itself came from.
 *
 * Structurally satisfied by `PluginComposeService`, so `ServiceManager` hands
 * over what it already holds and no second resolution of "which plugin, which
 * generation" happens here.
 */
export interface PluginServiceCredentialNeed {
  name: string;
  credentials: readonly string[];
}

// ---------------------------------------------------------------------------
// ServiceSecretsResolver
// ---------------------------------------------------------------------------

export class ServiceSecretsResolver {
  private readonly sessionId: string;
  private readonly workspaceDir: string;
  private secretsLoader?: () => Promise<Record<string, string>>;
  private readonly accountAgentEnvLoader?: () => Record<string, string>;
  private readonly dockerSecretsConfig?: DockerSecretsConfig;
  private readonly serviceEnvDir: string;
  private readonly onSnapshot?: (snapshot: SecretsStatusInternalSnapshot) => void;
  private readonly onPlatformSourceWarning?: (serviceName: string, text: string) => void;
  private readonly pluginCredentialsLoader?: () => PluginCredentialDeclaration[];
  /** (service, name, source) tuples already warned about — see onPlatformSourceWarning. */
  private readonly warnedPlatformSources = new Set<string>();

  private declaredSecretNames: string[] = [];
  private missingSecretsByService: Record<string, string[]> = {};
  private snapshot: SecretsStatusInternalSnapshot = {
    declared: [],
    missingByService: {},
    missingRequired: [],
    agentNames: [],
    plugins: [],
    agentValues: {},
  };
  /**
   * Whether `sync()` has completed at least once. Distinguishes "no secrets
   * are declared" from "we haven't looked yet" — both of which leave
   * {@link snapshot} at its empty initial value. The WS attach replay keys off
   * this: once a sync has run, the snapshot is authoritative and is replayed
   * even when empty (a compose file that DROPPED its `x-shipit-secrets` must
   * clear the client's declared list); before that, there is nothing to say.
   */
  private synced = false;

  private dockerSecretsBuild?: DockerSecretsBuild;
  /**
   * docs/183 — service-name → absolute env-file path from the most recent
   * `sync()`. The compose generator reads this to emit absolute `env_file:`
   * paths. `undefined` before the first `sync()`, and in Docker-secrets mode
   * (which delivers via `secrets:` instead).
   */
  private serviceEnvFiles?: Record<string, string>;
  /**
   * docs/262 req 23 — plugin service name → the credential values that service
   * is to receive, from the most recent `sync()`.
   */
  private pluginServiceEnv?: Record<string, Record<string, string>>;

  constructor(opts: ServiceSecretsResolverOptions) {
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.secretsLoader = opts.secretsLoader;
    this.accountAgentEnvLoader = opts.accountAgentEnvLoader;
    this.dockerSecretsConfig = opts.dockerSecretsConfig;
    this.serviceEnvDir = opts.serviceEnvDir;
    this.onSnapshot = opts.onSnapshot;
    this.onPlatformSourceWarning = opts.onPlatformSourceWarning;
    this.pluginCredentialsLoader = opts.pluginCredentialsLoader;
  }

  /**
   * Update or replace the secrets loader. Called when the session's
   * remoteUrl changes (e.g. after warm-session graduation) so subsequent
   * reconciles read the right slice of SecretStore.
   */
  setSecretsLoader(loader: () => Promise<Record<string, string>>): void {
    this.secretsLoader = loader;
  }

  /** Names of secrets declared in `x-shipit-secrets` across all services. */
  getDeclaredNames(): string[] {
    return [...this.declaredSecretNames];
  }

  /** Missing secrets (required + optional) by service. */
  getMissingByService(): Record<string, string[]> {
    return { ...this.missingSecretsByService };
  }

  /**
   * Latest snapshot — declared requirements + per-service missing +
   * de-duplicated required-and-missing names + resolved agent values.
   * Returns a defensive copy so callers can't mutate resolver state.
   */
  getSnapshot(): SecretsStatusInternalSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  /** Whether {@link sync} has run — i.e. whether the snapshot means anything. */
  get hasSynced(): boolean {
    return this.synced;
  }

  /**
   * Per-secret file references for the most recent compose override. Only
   * populated when Docker-secrets mode is active. The compose generator
   * uses this to emit `secrets:` entries instead of `env_file:`.
   */
  getDockerSecretsBuild(): DockerSecretsBuild | undefined {
    return this.dockerSecretsBuild;
  }

  /**
   * docs/183 — service-name → absolute env-file path for the most recent
   * compose override. The compose generator uses this to emit absolute
   * `env_file:` paths. `undefined` before the first `sync()` and in
   * Docker-secrets mode, both of which mean "no `env_file:` entries to emit".
   */
  getServiceEnvFiles(): Record<string, string> | undefined {
    return this.serviceEnvFiles ? { ...this.serviceEnvFiles } : undefined;
  }

  /**
   * docs/262 req 23 — plugin service name → the declared credentials that
   * service's plugin actually gets, resolved from the consuming project's own
   * store. The override generator emits them as that service's `environment:`.
   *
   * `undefined` before the first `sync()`. A service whose plugin declares no
   * credential, or none this project has a value for, gets an empty map rather
   * than no entry — "nothing to deliver" is an answer, not a gap in the data.
   */
  getPluginServiceEnv(): Record<string, Record<string, string>> | undefined {
    if (!this.pluginServiceEnv) return undefined;
    return Object.fromEntries(
      Object.entries(this.pluginServiceEnv).map(([svc, values]) => [svc, { ...values }]),
    );
  }

  /** Whether Docker-secrets isolation mode is configured. */
  get dockerSecretsModeEnabled(): boolean {
    return !!this.dockerSecretsConfig;
  }

  /**
   * Resolve secrets and write per-service env files. Always runs (even when
   * no secrets are declared) so stale `.env.<svc>` files are swept.
   *
   * Also publishes the latest snapshot via `onSnapshot` so subscribers
   * (the runner → WS → client) can render the secrets banner / panel
   * without polling. Emitted on every call regardless of whether the
   * snapshot changed — listeners are cheap, debouncing is the consumer's
   * concern.
   */
  async sync(
    parsedServices: ComposeService[],
    pluginServices: readonly PluginServiceCredentialNeed[] = [],
  ): Promise<void> {
    let userSecrets: Record<string, string> = {};
    if (this.secretsLoader) {
      try {
        userSecrets = await this.secretsLoader();
      } catch (err) {
        console.warn(`[compose:${this.sessionId}] secretsLoader failed:`, (err as Error).message);
      }
    }
    const resolution = resolveSecrets({
      services: parsedServices,
      userSecrets,
    });
    this.declaredSecretNames = resolution.declaredNames;
    this.missingSecretsByService = resolution.missingByService;

    // docs/184: warn (once per entry) when a compose file still declares a
    // now-unhonored `source: platform:*`. The value was NOT forwarded; the
    // user must set a user secret of the same name if the service needs it.
    this.warnPlatformSources(resolution.platformSourceWarnings);

    // docs/088 + docs/252: merge the ACCOUNT-LEVEL set — MCP secrets (`mcp__*`),
    // MCP OAuth tokens, and the user's stored service credentials — into the
    // resolved agent-env set. This runs AFTER `resolveSecrets()`: account-level
    // secrets are never declared in compose, so they take a separate path.
    // Compose-declared entries win on key collision (they are explicit per-repo
    // overrides), which is the pre-existing precedence and applies unchanged to
    // service credentials.
    let mergedAgentValues = resolution.agentValues;
    if (this.accountAgentEnvLoader) {
      let accountEnv: Record<string, string> = {};
      try {
        accountEnv = this.accountAgentEnvLoader();
      } catch (err) {
        console.warn(`[compose:${this.sessionId}] accountAgentEnvLoader failed:`, (err as Error).message);
      }
      mergedAgentValues = { ...accountEnv, ...resolution.agentValues };
    }

    // De-duplicate required-and-missing across services. Same secret name
    // declared `required: true` by multiple services collapses to one entry
    // in the banner — duplicate entries would produce duplicate UI rows.
    const missingRequired = [
      ...new Set(Object.values(resolution.missingRequiredByService).flat()),
    ].sort();

    // docs/262 req 23 — plugin-declared credential names, resolved against
    // `userSecrets`: the consuming project's own secret store, the SAME map
    // the compose services just resolved from. `mergedAgentValues` — which
    // carries ShipIt's account-level credentials (provider tokens, MCP OAuth)
    // — is deliberately not consulted here and must never be: a plugin's
    // store can never resolve ShipIt's own platform credentials (req 23).
    const pluginDeclarations = this.loadPluginCredentials();
    const satisfied = satisfiedCredentialNames(userSecrets);

    // The same set, one expression later, decides what each plugin SERVICE
    // container receives. That adjacency is the point: the card's "satisfied"
    // and the container's environment are one computation over one map, so they
    // cannot disagree — which they did, when the delivery half did not exist at
    // all and every declared name read as satisfied while the service got
    // nothing.
    this.pluginServiceEnv = resolvePluginServiceEnv(pluginServices, userSecrets, satisfied);

    this.snapshot = {
      declared: mergePluginClaimants(resolution.declared, pluginDeclarations),
      missingByService: resolution.missingByService,
      missingRequired,
      agentNames: Object.keys(mergedAgentValues).sort(),
      plugins: resolvePluginCredentials(pluginDeclarations, satisfied),
      agentValues: mergedAgentValues,
    };
    this.synced = true;
    this.onSnapshot?.(cloneSnapshot(this.snapshot));

    // Two delivery modes, both writing outside the session's git clone. There is
    // no third: the in-workspace `.shipit/.env.<svc>` fallback was deleted with
    // planning#292, and `serviceEnvDir` is required so there is nothing to fall back
    // from.
    if (this.dockerSecretsConfig) {
      // Phase 1 follow-up: Docker-secrets mode. Write per-secret files to
      // the orchestrator-private directory and build the override metadata.
      this.serviceEnvFiles = undefined;
      this.applyDockerSecretsMode(resolution);
    } else {
      // docs/183: default mode — write service env files to an
      // orchestrator-private root OUTSIDE the workspace and reference the
      // returned absolute paths from the compose override. Keeps service-only
      // secrets out of the agent-readable workspace.
      const { serviceEnvFiles } = writeServiceEnvFilesToRoot({
        rootDir: this.serviceEnvDir,
        sessionId: this.sessionId,
        workspaceDir: this.workspaceDir,
        perServiceEnv: resolution.perServiceEnv,
      });
      this.serviceEnvFiles = serviceEnvFiles;
    }

    // Phase 3 (087) + docs/088: write the agent env file from the merged
    // set (compose `agent: true` values + account-level `mcp__*` secrets).
    // Empty body removes the file.
    // docs/246 — orchestrator-side placement (the session state dir, resolved
    // from the clone path), restoring what docs/087 §403 specified: "This file
    // is on the orchestrator's filesystem, not the workspace volume."
    writeAgentEnvFile({
      workspaceDir: this.workspaceDir,
      body: renderAgentEnvBody(mergedAgentValues),
    });
  }

  /** Never let a plugin declaration failure break the compose secrets pass. */
  private loadPluginCredentials(): PluginCredentialDeclaration[] {
    if (!this.pluginCredentialsLoader) return [];
    try {
      return this.pluginCredentialsLoader();
    } catch (err) {
      console.warn(
        `[compose:${this.sessionId}] pluginCredentialsLoader failed:`,
        (err as Error).message,
      );
      return [];
    }
  }

  /**
   * docs/184 — emit a service-log notice for each compose entry that still
   * declares a now-unhonored `source: platform:*` field. De-duplicated per
   * (service, name, source) for the resolver's lifetime so the message isn't
   * repeated on every reconcile / `refreshSecrets()` pass.
   */
  private warnPlatformSources(warnings: { service: string; name: string; source: string }[]): void {
    if (!this.onPlatformSourceWarning) return;
    for (const w of warnings) {
      const key = `${w.service}\0${w.name}\0${w.source}`;
      if (this.warnedPlatformSources.has(key)) continue;
      this.warnedPlatformSources.add(key);
      this.onPlatformSourceWarning(
        w.service,
        `service "${w.service}": secret "${w.name}" declares source: ${w.source} ` +
          `which is no longer forwarded — set a "${w.name}" secret in ` +
          `Settings → Secrets if the service needs it.\n`,
      );
    }
  }

  /**
   * Phase 1 follow-up: write per-secret files outside the workspace and
   * stage compose-override metadata.
   *
   * Steps:
   *   1. De-duplicate values across services (one file per unique name).
   *   2. Write to `dockerSecretsConfig.internalDir/<sessionId>/<NAME>`.
   *   3. Build per-service references (each service only references the
   *      secrets it declared — scoping is preserved at the compose layer).
   *   4. Stage the entrypoint wrapper beside those files (planning#287), so compose
   *      can bind-mount it into service containers by absolute path.
   */
  private applyDockerSecretsMode(resolution: ReturnType<typeof resolveSecrets>): void {
    const cfg = this.dockerSecretsConfig;
    if (!cfg) return;

    // Collapse per-service values to a single name → value map. The same
    // name appearing under multiple services has the same value (it's the
    // same user-saved secret), so this is safe.
    const collapsed: Record<string, string> = {};
    for (const map of Object.values(resolution.perServiceValues)) {
      for (const [name, value] of Object.entries(map)) {
        collapsed[name] = value;
      }
    }

    const { written } = writeIsolatedSecretFiles({
      rootDir: cfg.internalDir,
      sessionId: this.sessionId,
      values: collapsed,
    });

    // Stage compose override metadata.
    const perService: Record<string, string[]> = {};
    for (const [svcName, values] of Object.entries(resolution.perServiceValues)) {
      const names = Object.keys(values);
      if (names.length > 0) perService[svcName] = names;
    }

    // planning#287 — stage the entrypoint wrapper in the Docker-secrets root, NOT in
    // the session clone. The old placement (`<clone>/.shipit/`) was chosen so
    // the wrapper could ride the workspace volume that service containers
    // already mount, but it put a ShipIt-generated file where the post-turn
    // `git add -A` commits it into the user's repository (docs/246-shipit-state-out-of-clone req 1). The
    // secrets root is the one directory this mode already has a daemon-side
    // mapping for, so the override can bind-mount the wrapper by absolute path
    // and stop depending on the workspace mount entirely. Refreshed on every
    // reconcile in case the baked-in script changed.
    const entrypointHostPath = stageSecretsEntrypoint({
      rootDir: cfg.internalDir,
      ...(cfg.hostDir ? { hostDir: cfg.hostDir } : {}),
      sessionId: this.sessionId,
      sourcePath: cfg.entrypointSourcePath,
    });

    this.dockerSecretsBuild = {
      secretNames: written,
      perService,
      filePathFor: (name) => composeSecretFilePath({
        rootDir: cfg.internalDir,
        ...(cfg.hostDir ? { hostDir: cfg.hostDir } : {}),
        sessionId: this.sessionId,
        name,
      }),
      ...(entrypointHostPath ? { entrypointHostPath } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * docs/262 req 23 — what each plugin service is to receive: exactly the
 * credential names its plugin declared, and only those the consuming project
 * has a value for.
 *
 * Four properties, each load-bearing:
 *
 *  - **Only declared names.** The set is the intersection of the plugin's
 *    manifest declaration with what this project has stored. A fragment cannot
 *    widen it: `x-shipit-secrets`, `secrets` and `env_file` are all refused by
 *    the fragment allowlist (`plugin-compose.ts`), and these values are merged
 *    into the emitted service's `environment` by ShipIt, over anything the
 *    fragment put there. So delivering a value never became a way for a plugin
 *    to name something it did not declare, nor to shadow what it did.
 *  - **Only the consuming project's store.** `userSecrets` is `secretsLoader`'s
 *    map: `SecretStore.loadSecrets(<this session's remoteUrl>)`.
 *    `CredentialStore` — ShipIt's GitHub identity, tracker and agent tokens —
 *    is reachable in this class only through `accountAgentEnvLoader`, whose map
 *    is deliberately not an argument here.
 *  - **A declared plugin credential is not a FETCH credential** (req 19), and
 *    the two live in different worlds rather than being told apart here. A
 *    fetch credential is minted per fetch by `resolvePluginFetchCredential`
 *    (`plugin-fetch.ts`) and handed to git as a `GitRemoteCredential`
 *    (`repo-git.ts`) for the life of one command; it is written to no store, so
 *    there is no name in `userSecrets` it could arrive under. What this
 *    delivers is the other kind entirely: a name the plugin's manifest asked
 *    for, for the plugin's own job, whose value the user typed into this
 *    project's Settings → Secrets.
 *  - **A missing key is omitted, never sent empty**, and the service still
 *    STARTS. Req 23 wants a named gap on the plugin's card; an empty-string
 *    credential turns that into a third-party authentication error instead. The
 *    manifest declares names with no required/optional distinction, so refusing
 *    to start would make every optional key fatal and — under the
 *    all-or-nothing service rule — would take out a whole repository over one
 *    unset name. The companion CLI already omits-and-runs; two surfaces
 *    disagreeing about one declared name is the worse failure.
 */
function resolvePluginServiceEnv(
  pluginServices: readonly PluginServiceCredentialNeed[],
  userSecrets: Record<string, string>,
  satisfied: ReadonlySet<string>,
): Record<string, Record<string, string>> {
  const perService: Record<string, Record<string, string>> = {};
  for (const svc of pluginServices) {
    const values: Record<string, string> = {};
    for (const name of svc.credentials) {
      if (satisfied.has(name)) values[name] = userSecrets[name];
    }
    perService[svc.name] = values;
  }
  return perService;
}

/**
 * docs/262 req 23 — fold plugin-declared credential names into the flat
 * declared list the Secrets settings panel renders.
 *
 * Two rules, both from plan §3:
 *   - A name a compose service ALREADY declares gains plugin claimants; it
 *     stays one row, because it is one stored secret. The compose metadata
 *     (`required`, `agent`, description) is authoritative and untouched — a
 *     plugin never gets to mark a project's secret required.
 *   - A name only a plugin declares becomes a new row with no consuming
 *     service, so the user can set it from the same panel instead of hunting
 *     for where a plugin's key is supposed to go.
 */
function mergePluginClaimants(
  declared: readonly DeclaredSecret[],
  pluginDeclarations: readonly PluginCredentialDeclaration[],
): DeclaredSecret[] {
  if (pluginDeclarations.length === 0) return [...declared];

  const merged = new Map(declared.map((d) => [d.name, { ...d, services: [...d.services] }]));
  for (const name of pluginCredentialNames(pluginDeclarations)) {
    const claimants = pluginClaimantsOf(pluginDeclarations, name);
    const existing = merged.get(name);
    if (existing) {
      existing.plugins = claimants;
    } else {
      merged.set(name, { name, services: [], plugins: claimants });
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function cloneSnapshot(snapshot: SecretsStatusInternalSnapshot): SecretsStatusInternalSnapshot {
  return {
    declared: snapshot.declared.map((d) => ({
      ...d,
      services: [...d.services],
      ...(d.plugins ? { plugins: [...d.plugins] } : {}),
    })),
    missingByService: Object.fromEntries(
      Object.entries(snapshot.missingByService).map(([k, v]) => [k, [...v]]),
    ),
    missingRequired: [...snapshot.missingRequired],
    agentNames: [...snapshot.agentNames],
    plugins: snapshot.plugins.map((g) => ({ ...g, credentials: g.credentials.map((c) => ({ ...c })) })),
    agentValues: { ...snapshot.agentValues },
  };
}
