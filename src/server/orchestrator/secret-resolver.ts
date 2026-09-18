import fs from "node:fs";
import path from "node:path";
import type { ComposeService } from "./compose-generator.js";
import { AGENT_ENV_FILE, sessionStateDirForWorkspace } from "./session-state-dir.js";
import type { CredentialRoute, SecretRequirement } from "../shared/types/domain-types.js";
import {
  credentialModeKey,
  credentialRouteEnvName,
  orderCredentialRoutes,
  parseCredentialModeKey,
} from "../shared/types/domain-types.js";
import { storageEnvFor } from "../shared/catalogue/index.js";
import type { CredentialStore } from "./credential-store.js";

export interface SecretResolution {
  perServiceEnv: Record<string, string>;
  missingByService: Record<string, string[]>;
  missingRequiredByService: Record<string, string[]>;
  declaredNames: string[];
  declared: DeclaredSecret[];
  agentEnv: string;
  agentValues: Record<string, string>;
  perServiceValues: Record<string, Record<string, string>>;
  platformSourceWarnings: PlatformSourceWarning[];
}

export interface PlatformSourceWarning {
  service: string;
  name: string;
  source: string;
}

export interface DeclaredSecret extends SecretRequirement {
  services: string[];
  plugins?: string[];
  /** Plugin requirements affect settings labels, not the preview's blocking banner. */
  pluginRequired?: boolean;
}

export function resolveSecrets(opts: {
  services: ComposeService[];
  userSecrets: Record<string, string>;
}): SecretResolution {
  const { services, userSecrets } = opts;
  const perServiceEnv: Record<string, string> = {};
  const perServiceValues: Record<string, Record<string, string>> = {};
  const missingByService: Record<string, string[]> = {};
  const missingRequiredByService: Record<string, string[]> = {};
  const declaredByName = new Map<string, DeclaredSecret>();
  const agentValues: Record<string, string> = {};
  const platformSourceWarnings: PlatformSourceWarning[] = [];

  for (const svc of services) {
    if (!svc.secrets || svc.secrets.length === 0) continue;
    const requirements: SecretRequirement[] =
      svc.secretRequirements ?? svc.secrets.map((name) => ({ name }));

    const seen = new Set<string>();
    const unique: SecretRequirement[] = [];
    for (const req of requirements) {
      if (seen.has(req.name)) continue;
      seen.add(req.name);
      unique.push(req);
    }

    const present: { key: string; value: string }[] = [];
    const missing: string[] = [];
    const missingRequired: string[] = [];

    for (const req of unique) {
      mergeDeclared(declaredByName, req, svc.name);

      // Compose declarations must not expose platform credentials to service code.
      if (req.source?.startsWith("platform:")) {
        platformSourceWarnings.push({
          service: svc.name,
          name: req.name,
          source: req.source,
        });
      }
      const value = resolveValue(req, userSecrets);
      if (typeof value === "string" && value.length > 0) {
        present.push({ key: req.name, value });
        if (req.agent && agentValues[req.name] === undefined) {
          agentValues[req.name] = value;
        }
      } else {
        missing.push(req.name);
        if (req.required) missingRequired.push(req.name);
      }
    }

    if (missing.length > 0) {
      missingByService[svc.name] = missing;
    }
    if (missingRequired.length > 0) {
      missingRequiredByService[svc.name] = missingRequired;
    }

    perServiceEnv[svc.name] = renderEnvFile(present);
    perServiceValues[svc.name] = Object.fromEntries(present.map((p) => [p.key, p.value]));
  }

  const declared = [...declaredByName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ ...d, services: [...d.services].sort() }));

  const agentEntries = Object.entries(agentValues)
    .map(([key, value]) => ({ key, value }));
  const agentEnv = agentEntries.length > 0 ? renderEnvFile(agentEntries) : "";

  return {
    perServiceEnv,
    missingByService,
    missingRequiredByService,
    declaredNames: declared.map((d) => d.name),
    declared,
    agentEnv,
    agentValues,
    perServiceValues,
    platformSourceWarnings,
  };
}

export function collectMcpAgentEnv(
  credentialStore: Pick<
    CredentialStore,
    "getAllAgentEnv" | "getAllMcpOAuthTokens"
  >,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentialStore.getAllAgentEnv())) {
    if (key.startsWith("mcp__") && typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  for (const [source, tokens] of Object.entries(credentialStore.getAllMcpOAuthTokens())) {
    if (!tokens?.accessToken) continue;
    // Must match platformSourceEnvName() and the worker's MCP resolver.
    out[`MCP_PLATFORM_${source.toUpperCase()}`] = tokens.accessToken;
  }
  return out;
}

/** Route-specific variables enable failover; the group variable serves unpinned callers. */
export function collectServiceCredentialEnv(
  credentialStore: Pick<CredentialStore, "listCredentialRoutes" | "getCredentialSecret">,
): Record<string, string> {
  const out: Record<string, string> = {};
  const byMode = new Map<string, CredentialRoute[]>();
  for (const route of credentialStore.listCredentialRoutes()) {
    if (route.via !== "string") continue;
    const key = credentialModeKey(route.serviceId, route.billingMode);
    byMode.set(key, [...(byMode.get(key) ?? []), route]);
    const secret = credentialStore.getCredentialSecret(route.id);
    if (secret) out[credentialRouteEnvName(route.id)] = secret;
  }
  for (const [key, routes] of byMode) {
    const parsed = parseCredentialModeKey(key);
    if (!parsed) continue;
    const envName = storageEnvFor(parsed.serviceId, parsed.billingMode);
    if (!envName) continue;
    const first = orderCredentialRoutes(routes)[0];
    const secret = first ? credentialStore.getCredentialSecret(first.id) : undefined;
    if (secret) out[envName] = secret;
  }
  return out;
}

export function collectAccountAgentEnv(
  credentialStore: Pick<
    CredentialStore,
    "getAllAgentEnv" | "getAllMcpOAuthTokens" | "listCredentialRoutes" | "getCredentialSecret"
  >,
): Record<string, string> {
  return {
    ...collectMcpAgentEnv(credentialStore),
    ...collectServiceCredentialEnv(credentialStore),
  };
}

function resolveValue(
  req: SecretRequirement,
  userSecrets: Record<string, string>,
): string | undefined {
  const userValue = userSecrets[req.name];
  if (typeof userValue === "string" && userValue.length > 0) return userValue;
  return undefined;
}

function mergeDeclared(
  acc: Map<string, DeclaredSecret>,
  req: SecretRequirement,
  serviceName: string,
): void {
  const existing = acc.get(req.name);
  if (!existing) {
    const next: DeclaredSecret = { name: req.name, services: [serviceName] };
    if (req.description) next.description = req.description;
    if (req.required) next.required = true;
    if (req.agent) next.agent = true;
    if (req.source) next.source = req.source;
    acc.set(req.name, next);
    return;
  }
  if (!existing.services.includes(serviceName)) {
    existing.services.push(serviceName);
  }
  if (!existing.description && req.description) existing.description = req.description;
  if (req.required) existing.required = true;
  if (req.agent) existing.agent = true;
  if (!existing.source && req.source) existing.source = req.source;
}

export function renderAgentEnvBody(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) => ({ key, value }));
  return entries.length > 0 ? renderEnvFile(entries) : "";
}

function renderEnvFile(entries: { key: string; value: string }[]): string {
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  const lines: string[] = [
    "# Generated by ShipIt — do not edit manually.",
    "# This file holds secrets for a single compose service. Rewritten on every",
    "# session activation and on PUT /api/secrets.",
  ];
  for (const { key, value } of sorted) {
    if (value.includes("\n") || value.includes("\r")) {
      continue;
    }
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

export function writeServiceEnvFilesToRoot(opts: {
  rootDir: string;
  sessionId: string;
  workspaceDir: string;
  perServiceEnv: Record<string, string>;
}): { serviceEnvFiles: Record<string, string>; sessionDir: string } {
  const { rootDir, sessionId, workspaceDir, perServiceEnv } = opts;
  assertServiceEnvRootOutsideWorkspace(rootDir, workspaceDir);

  const sessionDir = path.join(rootDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  let existing: string[];
  try {
    existing = fs.readdirSync(sessionDir);
  } catch {
    existing = [];
  }
  const keep = new Set<string>();
  for (const svc of Object.keys(perServiceEnv)) keep.add(`.env.${svc}`);
  for (const entry of existing) {
    if (!entry.startsWith(".env.")) continue;
    if (keep.has(entry)) continue;
    try {
      fs.unlinkSync(path.join(sessionDir, entry));
    } catch {
      // Best-effort cleanup.
    }
  }

  const serviceEnvFiles: Record<string, string> = {};
  for (const [serviceName, body] of Object.entries(perServiceEnv)) {
    const filePath = path.join(sessionDir, `.env.${serviceName}`);
    fs.writeFileSync(filePath, body, { mode: 0o600 });
    serviceEnvFiles[serviceName] = filePath;
  }

  return { serviceEnvFiles, sessionDir };
}

function removeSessionSecretDir(rootDir: string, sessionId: string): void {
  if (!sessionId) return;
  try {
    fs.rmSync(path.join(rootDir, sessionId), { recursive: true, force: true });
  } catch {
    // Cleanup failure must not block session teardown.
  }
}

export function removeSessionServiceEnvDir(opts: {
  rootDir: string;
  sessionId: string;
}): void {
  removeSessionSecretDir(opts.rootDir, opts.sessionId);
}

export function removeSessionSecretsDir(opts: {
  internalDir: string;
  sessionId: string;
}): void {
  removeSessionSecretDir(opts.internalDir, opts.sessionId);
}

function assertServiceEnvRootOutsideWorkspace(rootDir: string, workspaceDir: string): void {
  const root = realpathOrResolve(rootDir);
  const ws = realpathOrResolve(workspaceDir);
  const rel = path.relative(ws, root);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (inside) {
    throw new Error(
      `Refusing to write service env files: resolved service-env root "${root}" ` +
        `is inside the agent workspace "${ws}", which would expose service-only ` +
        `secrets to the agent. Set SHIPIT_SERVICE_ENV_DIR to a path outside the workspace.`,
    );
  }
}

function realpathOrResolve(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    // Resolve symlinked ancestors even when the target directory does not exist yet.
    let dir = abs;
    const tail: string[] = [];
    while (dir !== path.dirname(dir)) {
      try {
        const real = fs.realpathSync(dir);
        return tail.length ? path.join(real, ...tail.reverse()) : real;
      } catch {
        tail.push(path.basename(dir));
        dir = path.dirname(dir);
      }
    }
    return abs;
  }
}

export function writeIsolatedSecretFiles(opts: {
  rootDir: string;
  sessionId: string;
  values: Record<string, string>;
}): { written: string[]; sessionDir: string } {
  const { rootDir, sessionId, values } = opts;
  const sessionDir = path.join(rootDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  let existing: string[];
  try {
    existing = fs.readdirSync(sessionDir);
  } catch {
    existing = [];
  }
  for (const entry of existing) {
    if (entry in values) continue;
    try {
      fs.unlinkSync(path.join(sessionDir, entry));
    } catch {
      // Best-effort cleanup.
    }
  }

  const written: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const filePath = path.join(sessionDir, name);
    fs.writeFileSync(filePath, value, { mode: 0o600 });
    written.push(name);
  }
  return { written: written.sort(), sessionDir };
}

/** Compose file references need the Docker daemon's view of the path. */
export function composeSecretFilePath(opts: {
  rootDir: string;
  hostDir?: string;
  sessionId: string;
  name: string;
}): string {
  const base = opts.hostDir ?? opts.rootDir;
  return path.join(base, opts.sessionId, opts.name);
}

// Keep the shared wrapper outside session directories, which secret cleanup sweeps.
const SECRETS_ENTRYPOINT_SUBDIR = "_entrypoint";
const SECRETS_ENTRYPOINT_FILE = "secrets-entrypoint.sh";

export function stageSecretsEntrypoint(opts: {
  rootDir: string;
  hostDir?: string;
  sessionId: string;
  sourcePath: string;
}): string | null {
  const dir = path.join(opts.rootDir, SECRETS_ENTRYPOINT_SUBDIR);
  const dest = path.join(dir, SECRETS_ENTRYPOINT_FILE);
  const tmp = `${dest}.${opts.sessionId}.tmp`;
  try {
    // The daemon must traverse this directory; the wrapper contains no secrets.
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.copyFileSync(opts.sourcePath, tmp);
    fs.chmodSync(tmp, 0o755);
    // Atomic replacement prevents another session from mounting a partial script.
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    console.warn(`[secrets] failed to stage entrypoint wrapper:`, (err as Error).message);
    return null;
  }
  const base = opts.hostDir ?? opts.rootDir;
  return path.join(base, SECRETS_ENTRYPOINT_SUBDIR, SECRETS_ENTRYPOINT_FILE);
}

export function writeAgentEnvFile(opts: {
  workspaceDir: string;
  body: string;
}): string | null {
  const { workspaceDir, body } = opts;
  const targetDir = sessionStateDirForWorkspace(workspaceDir);
  const filePath = path.join(targetDir, AGENT_ENV_FILE);

  if (!body) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // The file may not exist.
    }
    return null;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(filePath, body, { mode: 0o600 });
  return path.relative(workspaceDir, filePath);
}
