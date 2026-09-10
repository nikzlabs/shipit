import {
  activateGeneration,
  readActiveGeneration,
  resolveLiveGenerations,
  retireSelfDeclaredGeneration,
  type ActivationOutcome,
  type BeginGenerationDeletion,
  type GenerationRecord,
  type ValidateStagedGeneration,
} from "../plugin-generations.js";
import { releaseSessionGenerationHolds } from "../plugin-leases.js";
import {
  createPluginImportResolver,
  preparePluginState,
  sessionRootForWorkspace,
} from "../plugin-state.js";
import { resolveShipitConfig, type ShipitConfig } from "../../shared/shipit-config.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";
import type { DeclaredHostsManifest } from "../../shared/plugin-hosts.js";
import type { DeclaredPluginRepo } from "../../shared/plugin-repos.js";
import { destinationKey, pluginCloneUrl } from "../../shared/plugin-repos.js";

export interface PluginRepoActivationState {
  activating: boolean;
  generation?: GenerationRecord;
  /** Can accompany a prior generation that remains active. */
  error?: string;
  warning?: string;
  missingSelectors?: string[];
  /** Hosts from the unpublished, failed version, needed for its Allow buttons. */
  declaredHosts?: DeclaredHostsManifest;
}

const activationState = new Map<string, PluginRepoActivationState>();

// Reject late writes after session disposal.
const epochs = new Map<string, number>();

// Only the last trigger clears activation; epochs isolate disposed rounds' decrements.
const inFlight = new Map<string, number>();

// Separate maps prevent independent writers from clearing each other's failures.
const prepareFailures = new Map<string, string[]>();
const containerFailures = new Map<string, string[]>();
const serviceFailures = new Map<string, string[]>();

const stateKey = (sessionId: string, repoName: string): string => `${sessionId}::${repoName}`;
const flightKey = (sessionId: string, epoch: number, repoName: string): string =>
  `${sessionId}::${epoch}::${repoName}`;

export function getActivationState(sessionId: string, repoName: string): PluginRepoActivationState | undefined {
  return activationState.get(stateKey(sessionId, repoName));
}

export function getPluginPrepareFailures(sessionId: string, repoName: string): string[] {
  return [
    ...(prepareFailures.get(stateKey(sessionId, repoName)) ?? []),
    ...(containerFailures.get(stateKey(sessionId, repoName)) ?? []),
  ];
}

export interface ContainerPrepareFailure {
  repo: string;
  /** `<alias>/<skill>`, alias, or `(all)`; absent for repository link failures. */
  skill?: string;
  reason: string;
}

// Older workers may omit repository attribution; discard those failures.
export function readPrepareFailures(body: unknown, sessionId: string): ContainerPrepareFailure[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const failures: ContainerPrepareFailure[] = [];
  let dropped = 0;

  const take = (list: unknown, withSkill: boolean): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
      const repo = item?.repo;
      const reason = item?.reason;
      const skill = item?.skill;
      if (typeof repo !== "string" || !repo || typeof reason !== "string") {
        dropped += 1;
        continue;
      }
      failures.push({
        repo,
        reason,
        ...(withSkill && typeof skill === "string" ? { skill } : {}),
      });
    }
  };
  take(record.skillsFailed, true);
  take(record.linkFailed, false);
  // Only the container can report commands shadowed on PATH.
  take(record.commandsRefused, false);
  take(record.commandsFailed, false);

  if (dropped > 0) {
    console.warn(
      `[plugins:${sessionId}] dropped ${dropped} prepare failure(s) this container did not attribute `
      + "to a declared repository — it is probably older than this orchestrator",
    );
  }
  return failures;
}

/**
 * Capture before sending prepare; call the recorder only for a completed prepare.
 * A timeout or unreachable worker must leave the previous failures intact.
 */
export function beginContainerPrepare(
  sessionId: string,
): (failures: readonly ContainerPrepareFailure[]) => boolean {
  const epoch = epochs.get(sessionId) ?? 0;
  return (failures) => {
    if ((epochs.get(sessionId) ?? 0) !== epoch) return false;

    const next = new Map<string, string[]>();
    for (const failure of failures) {
      const key = stateKey(sessionId, failure.repo);
      next.set(key, [...(next.get(key) ?? []), formatContainerFailure(failure)]);
    }

    let changed = false;
    for (const key of [...containerFailures.keys()]) {
      if (!key.startsWith(`${sessionId}::`) || next.has(key)) continue;
      containerFailures.delete(key);
      changed = true;
    }
    for (const [key, messages] of next) {
      const before = containerFailures.get(key);
      if (before?.length !== messages.length || before.some((m, i) => m !== messages[i])) changed = true;
      containerFailures.set(key, messages);
    }
    return changed;
  };
}

function formatContainerFailure(failure: ContainerPrepareFailure): string {
  if (failure.skill === undefined) return failure.reason;
  return failure.skill === "(all)"
    ? `Skills: ${failure.reason}`
    : `Skill \`${failure.skill}\`: ${failure.reason}`;
}

export function getPluginServiceFailures(sessionId: string, repoName: string): string[] {
  return serviceFailures.get(stateKey(sessionId, repoName)) ?? [];
}

export function recordPluginServiceFailures(
  sessionId: string,
  byRepo: ReadonlyMap<string, string[]>,
): void {
  for (const key of [...serviceFailures.keys()]) {
    if (key.startsWith(`${sessionId}::`)) serviceFailures.delete(key);
  }
  for (const [repoName, issues] of byRepo) {
    if (issues.length > 0) serviceFailures.set(stateKey(sessionId, repoName), issues);
  }
}

export function clearActivationState(sessionId: string): void {
  epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1);
  releaseSessionGenerationHolds(sessionId);
  for (const key of [...activationState.keys()]) {
    if (key.startsWith(`${sessionId}::`)) activationState.delete(key);
  }
  for (const key of [...inFlight.keys()]) {
    if (key.startsWith(`${sessionId}::`)) inFlight.delete(key);
  }
  for (const key of [...prepareFailures.keys()]) {
    if (key.startsWith(`${sessionId}::`)) prepareFailures.delete(key);
  }
  for (const key of [...containerFailures.keys()]) {
    if (key.startsWith(`${sessionId}::`)) containerFailures.delete(key);
  }
  for (const key of [...serviceFailures.keys()]) {
    if (key.startsWith(`${sessionId}::`)) serviceFailures.delete(key);
  }
}

export type ActivationSettledHook = (sessionId: string) => void;

export interface PluginActivationDeps {
  getBareCacheDir: (repoUrl: string) => string;
  pinStorePath: string;
  ensureCache: (cacheDir: string, repoUrl: string) => Promise<void>;
  onSettled?: ActivationSettledHook;
  /** Install in a separate container before publication; omitted in local mode. */
  runInstall?: PluginInstallHook;
  beginGenerationDeletion?: BeginGenerationDeletion;
  validateStaged?: ValidateStagedGeneration;
}

export type PluginInstallHook = NonNullable<Parameters<typeof activateGeneration>[1]["runInstall"]>;

export async function activateDeclaredPlugins(
  sessionId: string,
  workspaceDir: string,
  deps: PluginActivationDeps,
  consumerKey?: string,
  onlyRepo?: string,
  force?: boolean,
): Promise<Map<string, ActivationOutcome>> {
  // Return this caller's outcomes even when another round overwrites shared UI state.
  const outcomes = new Map<string, ActivationOutcome>();
  let config: ShipitConfig;
  let repos: DeclaredPluginRepo[];
  let selectedByRepo: Map<string, string[]>;
  let stateDir: string;
  try {
    config = resolveShipitConfig(workspaceDir);
  } catch {
    return outcomes;
  }

  const epoch = epochs.get(sessionId) ?? 0;
  const isCancelled = (): boolean => (epochs.get(sessionId) ?? 0) !== epoch;

  // Update every import, including self, against the newly active manifests.
  const settleRound = (): void => {
    if (isCancelled()) return;
    syncPluginState(sessionId, workspaceDir);
    deps.onSettled?.(sessionId);
  };

  try {
    // Settlement also removes container links for declarations that were deleted.
    if (!config.plugins.declared) {
      settleRound();
      return outcomes;
    }
    repos = config.plugins.repos.filter((r) => r.source.kind === "github");
    if (onlyRepo) {
      repos = repos.filter((r) => r.name.toLowerCase() === onlyRepo.toLowerCase());
    }
    selectedByRepo = new Map();
    for (const use of config.plugins.uses) {
      const key = use.from.toLowerCase();
      selectedByRepo.set(key, [...(selectedByRepo.get(key) ?? []), use.plugin]);
    }
    // Resolve after the empty-declaration path: an invalid layout must not prevent settlement.
    stateDir = sessionStateDirForWorkspace(workspaceDir);
  } catch {
    return outcomes;
  }
  // A switch to self has no tracked activation to retire its old checkout.
  if (!onlyRepo) {
    await retireSelfDeclaredGenerations(config.plugins.repos, workspaceDir, stateDir, deps, isCancelled);
  }

  if (repos.length === 0) {
    settleRound();
    return outcomes;
  }

  const setState = (repoName: string, state: PluginRepoActivationState): void => {
    if (isCancelled()) return;
    activationState.set(stateKey(sessionId, repoName), state);
  };

  await Promise.all(
    repos.map(async (repo) => {
      const key = flightKey(sessionId, epoch, repo.name);
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
      const existing = readActiveGeneration(stateDir, repo.name, destinationKey(repo.source)) ?? undefined;
      setState(repo.name, { activating: true, ...(existing ? { generation: existing } : {}) });

      const repoUrl = cloneUrl(repo);
      let outcome: Awaited<ReturnType<typeof activateGeneration>>;
      try {
        outcome = await activateGeneration(repo, {
          stateDir,
          bareCacheDir: deps.getBareCacheDir(repoUrl),
          repoUrl,
          consumerKey: consumerKey ?? `session:${sessionId}`,
          pinStorePath: deps.pinStorePath,
          selectedExports: selectedByRepo.get(repo.name.toLowerCase()) ?? [],
          ensureCache: deps.ensureCache,
          isCancelled,
          ...(deps.runInstall ? { runInstall: deps.runInstall } : {}),
          ...(deps.validateStaged ? { validateStaged: deps.validateStaged } : {}),
          ...(deps.beginGenerationDeletion
            ? { beginGenerationDeletion: deps.beginGenerationDeletion }
            : {}),
          // Force discards writable layers, so require an explicit repository.
          ...(force && onlyRepo ? { force: true } : {}),
        });
      } catch (err) {
        outcome = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
      }
      outcomes.set(repo.name, outcome);

      const remaining = (inFlight.get(key) ?? 1) - 1;
      if (remaining > 0) {
        inFlight.set(key, remaining);
        return;
      }
      inFlight.delete(key);

      if (outcome.status === "failed") {
        setState(repo.name, {
          activating: false,
          error: outcome.reason,
          ...(outcome.previous ? { generation: outcome.previous } : {}),
          ...(outcome.warning ? { warning: outcome.warning } : {}),
          ...(outcome.missingSelectors?.length ? { missingSelectors: outcome.missingSelectors } : {}),
          ...(outcome.declaredHosts?.length ? { declaredHosts: outcome.declaredHosts } : {}),
        });
        console.warn(`[plugins:${sessionId}] ${repo.name}: ${outcome.reason}`);
        return;
      }
      setState(repo.name, {
        activating: false,
        generation: outcome.generation,
        ...(outcome.warning ? { warning: outcome.warning } : {}),
      });
    }),
  );

  settleRound();
  return outcomes;
}

function syncPluginState(sessionId: string, workspaceDir: string): void {
  try {
    // Re-read so a slow, older round cannot restore superseded settings.
    const config = resolveShipitConfig(workspaceDir);
    const entries = preparePluginState({
      // Keep durable state outside the reclaimable state directory.
      sessionDir: sessionRootForWorkspace(workspaceDir),
      uses: config.plugins.uses,
      resolver: createPluginImportResolver(
        config.plugins,
        config.pluginExports,
        resolveLiveGenerations(sessionStateDirForWorkspace(workspaceDir), config.plugins.repos),
      ),
    });

    // Snapshots can recompute resolution issues, but cannot reconstruct failed writes.
    for (const key of [...prepareFailures.keys()]) {
      if (key.startsWith(`${sessionId}::`)) prepareFailures.delete(key);
    }
    for (const entry of entries) {
      for (const issue of entry.issues) console.warn(`[plugins:${sessionId}] ${issue}`);
      if (!entry.failure) continue;
      console.warn(`[plugins:${sessionId}] ${entry.failure}`);
      const key = stateKey(sessionId, entry.repo ?? entry.alias);
      prepareFailures.set(key, [...(prepareFailures.get(key) ?? []), entry.failure]);
    }
  } catch (err) {
    console.warn(
      `[plugins:${sessionId}] could not prepare plugin state:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function retireSelfDeclaredGenerations(
  repos: readonly DeclaredPluginRepo[],
  workspaceDir: string,
  stateDir: string,
  deps: PluginActivationDeps,
  isCancelled: () => boolean,
): Promise<void> {
  for (const repo of repos) {
    if (repo.source.kind !== "self" || isCancelled()) continue;
    try {
      await retireSelfDeclaredGeneration(
        stateDir,
        repo.name,
        deps.beginGenerationDeletion,
        // Re-read when dequeued: a later declaration may have published a tracked version.
        () => isSelfDeclared(workspaceDir, repo.name) && !isCancelled(),
      );
    } catch (err) {
      console.warn(
        `[plugins] ${repo.name}: could not retire a version left under a \`repo: self\` name:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function isSelfDeclared(workspaceDir: string, repoName: string): boolean {
  try {
    return resolveShipitConfig(workspaceDir).plugins.repos.some(
      (r) => r.source.kind === "self" && r.name.toLowerCase() === repoName.toLowerCase(),
    );
  } catch {
    return false;
  }
}

function cloneUrl(repo: DeclaredPluginRepo): string {
  return pluginCloneUrl(repo.source);
}
