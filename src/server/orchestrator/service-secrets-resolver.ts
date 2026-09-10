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
  pluginRequiresName,
  pluginCredentialNames,
  resolvePluginCredentials,
  satisfiedCredentialNames,
  type PluginCredentialDeclaration,
  type PluginCredentialGroup,
} from "../shared/plugin-credentials.js";

export interface SecretsStatusSnapshot {
  declared: DeclaredSecret[];
  missingByService: Record<string, string[]>;
  missingRequired: string[];
  agentNames: string[];
  // Plugin gaps appear on plugin cards and must not block the project preview.
  plugins: PluginCredentialGroup[];
}

// Keep raw values out of the public snapshot type.
export interface SecretsStatusInternalSnapshot extends SecretsStatusSnapshot {
  agentValues: Record<string, string>;
}

export interface DockerSecretsBuild {
  secretNames: string[];
  perService: Record<string, string[]>;
  filePathFor: (name: string) => string;
  // Daemon-visible path; omitted if staging failed.
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
  // Must be outside the agent-readable workspace.
  serviceEnvDir: string;
  onSnapshot?: (snapshot: SecretsStatusInternalSnapshot) => void;
  onPlatformSourceWarning?: (serviceName: string, text: string) => void;
  pluginCredentialsLoader?: () => PluginCredentialDeclaration[];
}

export interface PluginServiceCredentialNeed {
  name: string;
  credentials: readonly string[];
}

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
  // An empty snapshot is authoritative only after the first sync.
  private synced = false;

  private dockerSecretsBuild?: DockerSecretsBuild;
  private serviceEnvFiles?: Record<string, string>;
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

  setSecretsLoader(loader: () => Promise<Record<string, string>>): void {
    this.secretsLoader = loader;
  }

  getDeclaredNames(): string[] {
    return [...this.declaredSecretNames];
  }

  getMissingByService(): Record<string, string[]> {
    return { ...this.missingSecretsByService };
  }

  getSnapshot(): SecretsStatusInternalSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  get hasSynced(): boolean {
    return this.synced;
  }

  getDockerSecretsBuild(): DockerSecretsBuild | undefined {
    return this.dockerSecretsBuild;
  }

  getServiceEnvFiles(): Record<string, string> | undefined {
    return this.serviceEnvFiles ? { ...this.serviceEnvFiles } : undefined;
  }

  getPluginServiceEnv(): Record<string, Record<string, string>> | undefined {
    if (!this.pluginServiceEnv) return undefined;
    return Object.fromEntries(
      Object.entries(this.pluginServiceEnv).map(([svc, values]) => [svc, { ...values }]),
    );
  }

  get dockerSecretsModeEnabled(): boolean {
    return !!this.dockerSecretsConfig;
  }

  // Run even with no declarations to remove stale secret files.
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

    this.warnPlatformSources(resolution.platformSourceWarnings);

    // Explicit project values override account-level agent values.
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

    const missingRequired = [
      ...new Set(Object.values(resolution.missingRequiredByService).flat()),
    ].sort();

    // Plugins receive project secrets, never account-level platform credentials.
    const pluginDeclarations = this.loadPluginCredentials();
    const satisfied = satisfiedCredentialNames(userSecrets);

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

    if (this.dockerSecretsConfig) {
      this.serviceEnvFiles = undefined;
      this.applyDockerSecretsMode(resolution);
    } else {
      const { serviceEnvFiles } = writeServiceEnvFilesToRoot({
        rootDir: this.serviceEnvDir,
        sessionId: this.sessionId,
        workspaceDir: this.workspaceDir,
        perServiceEnv: resolution.perServiceEnv,
      });
      this.serviceEnvFiles = serviceEnvFiles;
    }

    writeAgentEnvFile({
      workspaceDir: this.workspaceDir,
      body: renderAgentEnvBody(mergedAgentValues),
    });
  }

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

  private applyDockerSecretsMode(resolution: ReturnType<typeof resolveSecrets>): void {
    const cfg = this.dockerSecretsConfig;
    if (!cfg) return;

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

    const perService: Record<string, string[]> = {};
    for (const [svcName, values] of Object.entries(resolution.perServiceValues)) {
      const names = Object.keys(values);
      if (names.length > 0) perService[svcName] = names;
    }

    // Stage outside the clone, using the secrets root's daemon-side mapping.
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

// Omit missing values; optional plugin credentials must not prevent service starts.
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

function mergePluginClaimants(
  declared: readonly DeclaredSecret[],
  pluginDeclarations: readonly PluginCredentialDeclaration[],
): DeclaredSecret[] {
  if (pluginDeclarations.length === 0) return [...declared];

  const merged = new Map(declared.map((d) => [d.name, { ...d, services: [...d.services] }]));
  for (const name of pluginCredentialNames(pluginDeclarations)) {
    const claimants = pluginClaimantsOf(pluginDeclarations, name);
    // Keep plugin requirements separate from Compose's preview-blocking flag.
    const pluginRequired = pluginRequiresName(pluginDeclarations, name);
    const existing = merged.get(name);
    if (existing) {
      existing.plugins = claimants;
      existing.pluginRequired = pluginRequired;
    } else {
      merged.set(name, { name, services: [], plugins: claimants, pluginRequired });
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
