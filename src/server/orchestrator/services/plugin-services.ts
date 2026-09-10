import fs from "node:fs";
import path from "node:path";
import type Docker from "dockerode";
import {
  classifyComposeFailure,
  parseComposeFile,
  type ComposeFailure,
} from "../compose-generator.js";
import {
  buildPluginComposeServices,
  collectPluginFragments,
  type PluginComposeService,
  type PluginFragmentService,
} from "../plugin-compose.js";
import { ensurePluginRuntimeOverlay, resolvePluginOverlayRoots } from "../plugin-overlay.js";
import { holdGenerationsForOwner, pluginServiceOwner } from "../plugin-leases.js";
import { resolveLiveGenerations } from "../plugin-generations.js";
import { sessionRootForWorkspace, volumeSubpathFor } from "../plugin-state.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";
import { resolveShipitConfig, type ShipitConfig } from "../../shared/shipit-config.js";
import { recordPluginServiceFailures } from "./plugin-activation.js";

export interface PluginServiceDeps {
  docker?: Docker;
  workspaceVolume?: string;
  stateRoot?: string;
  depStoreDir?: string;
  containEgress: boolean;
}

export async function resolveSessionPluginServices(
  sessionId: string,
  workspaceDir: string,
  deps: PluginServiceDeps,
): Promise<PluginComposeService[]> {
  let config: ShipitConfig;
  try {
    config = resolveShipitConfig(workspaceDir);
  } catch {
    // An unreadable declaration is not evidence that running services released their generations.
    return [];
  }
  if (!config.plugins.declared || config.plugins.uses.length === 0) {
    return nothingToSurface(sessionId);
  }

  let stateDir: string;
  let sessionDir: string;
  try {
    stateDir = sessionStateDirForWorkspace(workspaceDir);
    sessionDir = sessionRootForWorkspace(workspaceDir);
  } catch {
    return nothingToSurface(sessionId);
  }

  const project = readProjectServices(workspaceDir, config, deps.containEgress);
  const { services: fragments } = collectPluginFragments({
    workspaceDir,
    live: resolveLiveGenerations(stateDir, config.plugins.repos),
    plugins: config.plugins,
    selfExports: config.pluginExports,
    projectServiceNames: project.names,
    containEgress: deps.containEgress,
  });
  if (fragments.length === 0) return nothingToSurface(sessionId);

  // Hold in the same synchronous block as resolution, before a prune can delete the generation.
  const { tracked, held } = holdResolvedGenerations(sessionId, fragments);

  // Failed daemon translation must not fall back to identity paths and replace a valid overlay.
  let overlayRoots: { volumeMountpoint?: string; stateRoot?: string } | "unresolved" = {};
  if (deps.docker) {
    try {
      overlayRoots = await resolvePluginOverlayRoots(deps.docker, deps.workspaceVolume, deps.stateRoot);
    } catch (err: unknown) {
      console.warn(
        `[plugins:${sessionId}] could not resolve the plugin overlay roots:`,
        err instanceof Error ? err.message : String(err),
      );
      overlayRoots = "unresolved";
    }
  }
  const pluginVolumes = overlayRoots === "unresolved"
    ? new Map<string, string>()
    : await ensurePluginVolumes(sessionId, stateDir, tracked, held, deps, overlayRoots);

  const sessionSubpath = volumeSubpath(sessionDir, deps);
  const workspaceSubpath = volumeSubpath(workspaceDir, deps);
  const built = buildPluginComposeServices(fragments, {
    sessionDir,
    ...(sessionSubpath ? { sessionSubpath } : {}),
    workspaceDir,
    ...(deps.workspaceVolume ? { workspaceVolume: deps.workspaceVolume } : {}),
    ...(workspaceSubpath ? { workspaceSubpath } : {}),
    pluginVolumes,
  });
  recordPluginServiceFailures(sessionId, built.issuesByRepo);
  return built.services;
}

function nothingToSurface(sessionId: string): PluginComposeService[] {
  recordPluginServiceFailures(sessionId, new Map());
  holdGenerationsForOwner(pluginServiceOwner(sessionId), []);
  return [];
}

function volumeSubpath(dir: string, deps: PluginServiceDeps): string | undefined {
  if (!deps.workspaceVolume || !deps.stateRoot) return undefined;
  return volumeSubpathFor(deps.stateRoot, dir) ?? undefined;
}

export interface ProjectServices {
  names: string[];
  /** Unknown names block preflight, but do not block services from existing generations. */
  unknown: boolean;
  failure?: ProjectComposeFailure;
}

export type ProjectComposeFailure = ComposeFailure;

export function readProjectServices(
  workspaceDir: string,
  config: ShipitConfig,
  containEgress: boolean,
): ProjectServices {
  if (!config.compose) return { names: [], unknown: false };
  const file = path.join(workspaceDir, config.compose.file);
  // A declared file that does not exist yet claims no service names.
  if (!fs.existsSync(file)) return { names: [], unknown: false };
  try {
    const parsed = parseComposeFile(file, {
      dockerSocket: config.compose.dockerSocket,
      containEgress,
    });
    return {
      names: parsed.map((s) => s.name),
      unknown: false,
    };
  } catch (err) {
    return {
      names: [],
      unknown: true,
      failure: classifyComposeFailure(err),
    };
  }
}

// Rebuilds share commits; leases and volumes must use the generation ID.
type TrackedGenerations = Map<string, { commit: string; generationId: string; checkoutDir: string }>;

function holdResolvedGenerations(
  sessionId: string,
  fragments: readonly PluginFragmentService[],
): { tracked: TrackedGenerations; held: Set<string> } {
  const tracked: TrackedGenerations = new Map();
  for (const fragment of fragments) {
    if (!fragment.self && fragment.commit) {
      tracked.set(fragment.repo, {
        commit: fragment.commit,
        // Legacy generations use the commit as their ID.
        generationId: fragment.generationId ?? fragment.commit,
        checkoutDir: fragment.checkoutDir,
      });
    }
  }
  const held = new Set(
    holdGenerationsForOwner(
      pluginServiceOwner(sessionId),
      [...tracked].map(([repoName, { generationId }]) => ({ sessionId, repoName, generationId })),
    ).map((ref) => ref.repoName),
  );
  return { tracked, held };
}

async function ensurePluginVolumes(
  sessionId: string,
  stateDir: string,
  tracked: TrackedGenerations,
  held: ReadonlySet<string>,
  deps: PluginServiceDeps,
  roots: { volumeMountpoint?: string; stateRoot?: string },
): Promise<Map<string, string>> {
  const volumes = new Map<string, string>();
  const docker = deps.docker;
  if (!docker) return volumes;

  for (const [repoName, { commit, generationId, checkoutDir }] of tracked) {
    if (!held.has(repoName)) {
      console.warn(
        `[plugins:${sessionId}] ${repoName}: ${commit.slice(0, 9)} is being replaced — leaving its services out of this round`,
      );
      continue;
    }
    try {
      // Reuse the resolved checkout and shared overlay creator; never resolve active again here.
      const volumeName = await ensurePluginRuntimeOverlay(docker, {
        sessionId,
        repoName,
        generationId,
        stateDir,
        checkoutDir,
        ...(deps.depStoreDir ? { depStoreDir: deps.depStoreDir } : {}),
        ...roots,
      });
      volumes.set(repoName, volumeName);
    } catch (err) {
      console.warn(
        `[plugins:${sessionId}] ${repoName}: could not prepare the plugin's runtime layer:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return volumes;
}
