/**
 * ServiceSecretsResolver — owns the secret-reconciliation slice of the
 * compose stack lifecycle.
 *
 * Extracted from `service-manager.ts` so the manager doesn't need to know
 * about platform credentials, MCP loaders, env-file vs Docker-secrets
 * delivery, or sweep semantics. The manager calls `sync(parsedServices)`
 * before each `compose up` (initial start, reconcile, `refreshSecrets`),
 * subscribes to snapshot updates via the `onSnapshot` callback, and reads
 * the resulting Docker-secrets build metadata back via
 * `getDockerSecretsBuild()` when generating the compose override.
 */

import fs from "node:fs";
import path from "node:path";
import {
  resolveSecrets,
  renderAgentEnvBody,
  writePerServiceEnvFiles,
  writeAgentEnvFile,
  writeIsolatedSecretFiles,
  composeSecretFilePath,
  type DeclaredSecret,
} from "./secret-resolver.js";
import type { ComposeService } from "./compose-generator.js";
import type { PlatformCredentialProvider } from "./platform-credentials.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretsStatusSnapshot {
  /** All declared secrets across all services, de-duplicated by name. */
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
  entrypointWorkspacePath: string;
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
  mcpAgentEnvLoader?: () => Record<string, string>;
  platformCredentials?: PlatformCredentialProvider;
  dockerSecretsConfig?: DockerSecretsConfig;
  /**
   * Called after every `sync()` pass. Receives a *defensive copy* of the
   * latest snapshot so the resolver and its subscribers don't share mutable
   * state.
   */
  onSnapshot?: (snapshot: SecretsStatusInternalSnapshot) => void;
}

// ---------------------------------------------------------------------------
// ServiceSecretsResolver
// ---------------------------------------------------------------------------

export class ServiceSecretsResolver {
  private readonly sessionId: string;
  private readonly workspaceDir: string;
  private secretsLoader?: () => Promise<Record<string, string>>;
  private readonly mcpAgentEnvLoader?: () => Record<string, string>;
  private readonly platformCredentials?: PlatformCredentialProvider;
  private readonly dockerSecretsConfig?: DockerSecretsConfig;
  private readonly onSnapshot?: (snapshot: SecretsStatusInternalSnapshot) => void;

  private declaredSecretNames: string[] = [];
  private missingSecretsByService: Record<string, string[]> = {};
  private snapshot: SecretsStatusInternalSnapshot = {
    declared: [],
    missingByService: {},
    missingRequired: [],
    agentNames: [],
    agentValues: {},
  };
  private dockerSecretsBuild?: DockerSecretsBuild;

  constructor(opts: ServiceSecretsResolverOptions) {
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.secretsLoader = opts.secretsLoader;
    this.mcpAgentEnvLoader = opts.mcpAgentEnvLoader;
    this.platformCredentials = opts.platformCredentials;
    this.dockerSecretsConfig = opts.dockerSecretsConfig;
    this.onSnapshot = opts.onSnapshot;
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

  /**
   * Per-secret file references for the most recent compose override. Only
   * populated when Docker-secrets mode is active. The compose generator
   * uses this to emit `secrets:` entries instead of `env_file:`.
   */
  getDockerSecretsBuild(): DockerSecretsBuild | undefined {
    return this.dockerSecretsBuild;
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
  async sync(parsedServices: ComposeService[]): Promise<void> {
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
      platformCredentials: this.platformCredentials,
    });
    this.declaredSecretNames = resolution.declaredNames;
    this.missingSecretsByService = resolution.missingByService;

    // docs/088: merge account-level MCP secrets (`mcp__*` keys) into the
    // resolved agent-env set. This runs AFTER `resolveSecrets()` — MCP
    // secrets are account-level and never declared in compose, so they take
    // a separate path. Compose-declared entries win on key collision (they
    // are explicit per-repo overrides).
    let mergedAgentValues = resolution.agentValues;
    if (this.mcpAgentEnvLoader) {
      let mcpEnv: Record<string, string> = {};
      try {
        mcpEnv = this.mcpAgentEnvLoader();
      } catch (err) {
        console.warn(`[compose:${this.sessionId}] mcpAgentEnvLoader failed:`, (err as Error).message);
      }
      mergedAgentValues = { ...mcpEnv, ...resolution.agentValues };
    }

    // De-duplicate required-and-missing across services. Same secret name
    // declared `required: true` by multiple services collapses to one entry
    // in the banner — duplicate entries would produce duplicate UI rows.
    const missingRequired = [
      ...new Set(Object.values(resolution.missingRequiredByService).flat()),
    ].sort();
    this.snapshot = {
      declared: resolution.declared,
      missingByService: resolution.missingByService,
      missingRequired,
      agentNames: Object.keys(mergedAgentValues).sort(),
      agentValues: mergedAgentValues,
    };
    this.onSnapshot?.(cloneSnapshot(this.snapshot));

    if (this.dockerSecretsConfig) {
      // Phase 1 follow-up: Docker-secrets mode. Write per-secret files to
      // the orchestrator-private directory and build the override metadata.
      // Sweep any leftover .env.<svc> files so the agent can't read stale
      // values from a previous reconcile.
      this.applyDockerSecretsMode(resolution);
    } else {
      writePerServiceEnvFiles({
        workspaceDir: this.workspaceDir,
        perServiceEnv: resolution.perServiceEnv,
      });
    }

    // Phase 3 (087) + docs/088: write the agent env file from the merged
    // set (compose `agent: true` values + account-level `mcp__*` secrets).
    // Empty body removes the file.
    writeAgentEnvFile({
      workspaceDir: this.workspaceDir,
      body: renderAgentEnvBody(mergedAgentValues),
    });
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
   *   4. Copy the entrypoint wrapper into `.shipit/secrets-entrypoint.sh`
   *      so compose can mount it into service containers.
   *   5. Sweep any stale `.shipit/.env.<svc>` files from a prior
   *      env-file-mode run.
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

    // Copy the entrypoint wrapper into the workspace `.shipit/` directory
    // so it's visible from the workspace volume that compose mounts into
    // service containers. We refresh on every reconcile in case the
    // baked-in script changed.
    const shipitDir = path.join(this.workspaceDir, ".shipit");
    fs.mkdirSync(shipitDir, { recursive: true });
    const wrapperDest = path.join(shipitDir, "secrets-entrypoint.sh");
    try {
      fs.copyFileSync(cfg.entrypointSourcePath, wrapperDest);
      fs.chmodSync(wrapperDest, 0o755);
    } catch (err) {
      console.warn(
        `[compose:${this.sessionId}] failed to copy entrypoint wrapper:`,
        (err as Error).message,
      );
    }

    this.dockerSecretsBuild = {
      secretNames: written,
      perService,
      filePathFor: (name) => composeSecretFilePath({
        rootDir: cfg.internalDir,
        ...(cfg.hostDir ? { hostDir: cfg.hostDir } : {}),
        sessionId: this.sessionId,
        name,
      }),
      entrypointWorkspacePath: ".shipit/secrets-entrypoint.sh",
    };

    // Sweep any leftover env-file-mode `.shipit/.env.<svc>` files so the
    // agent can't read stale plaintext values.
    let existing: string[] = [];
    try {
      existing = fs.readdirSync(shipitDir);
    } catch {
      existing = [];
    }
    for (const entry of existing) {
      if (!entry.startsWith(".env.") || entry === ".env.agent") continue;
      try {
        fs.unlinkSync(path.join(shipitDir, entry));
      } catch {
        // best-effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneSnapshot(snapshot: SecretsStatusInternalSnapshot): SecretsStatusInternalSnapshot {
  return {
    declared: snapshot.declared.map((d) => ({ ...d, services: [...d.services] })),
    missingByService: Object.fromEntries(
      Object.entries(snapshot.missingByService).map(([k, v]) => [k, [...v]]),
    ),
    missingRequired: [...snapshot.missingRequired],
    agentNames: [...snapshot.agentNames],
    agentValues: { ...snapshot.agentValues },
  };
}
