/**
 * docs/262 reqs 3, 5, 16, 18, 20 — the lifecycle half of `plugin-compose.ts`:
 * what a session's plugin services are RIGHT NOW.
 *
 * `plugin-compose.ts` is the pure edge — locate, validate, rename, mount. This
 * module is what a session actually calls, and it owns the three things that
 * edge cannot be pure about:
 *
 *  - **The plugin's runtime overlay volume.** A tracked plugin's own code is its
 *    checkout with its install output merged over it, and that merged view exists
 *    only inside a container that mounts the generation's `type=overlay` volume
 *    (`plugin-overlay.ts`). Install created one over the STAGING checkout and
 *    removed it before publish; this creates the runtime one, over the published
 *    generation and the same upper layer.
 *  - **Published ports** (`plugin-ports.ts`, req 18), which are per-session state.
 *  - **Remembering what could not be recomputed.** The snapshot route re-derives
 *    fragment problems itself from the same pure function, so only the failures
 *    that depend on Docker are kept here — the same split `plugin-state.ts` makes
 *    between its issues and its failures.
 *
 * Called on the two moments compose configuration is applied (session activation
 * and a `shipit.yaml` edit) and again whenever an activation round settles, which
 * is what makes `shipit plugin refresh` (req 12) reach the running services.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import type Docker from "dockerode";
import { parseComposeFile } from "../compose-generator.js";
import {
  buildPluginComposeServices,
  collectPluginFragments,
  type PluginComposeService,
  type PluginFragmentService,
} from "../plugin-compose.js";
import {
  buildPluginOverlaySpec,
  createPluginOverlay,
  removePluginOverlay,
  resolvePluginOverlayRoots,
  toDaemonPath,
  type PluginOverlaySpec,
} from "../plugin-overlay.js";
import { volumeExists } from "../overlay-volume.js";
import { activeLinkPath } from "../plugin-generations.js";
import { resolvePublishedPorts } from "../plugin-ports.js";
import { sessionRootForWorkspace } from "../plugin-state.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";
import { chownToSessionWorker } from "../session-worker-uid.js";
import { resolveShipitConfig, type ShipitConfig } from "../../shared/shipit-config.js";
import { recordPluginServiceFailures } from "./plugin-activation.js";

export interface PluginServiceDeps {
  /** Absent where there is no Docker (local/dogfood mode, tests). */
  docker?: Docker;
  /** Name of the workspace volume, and the orchestrator root that maps onto it. */
  workspaceVolume?: string;
  stateRoot?: string;
  /** Whether this session contains Compose-service egress (docs/263). */
  containEgress: boolean;
}

/**
 * Everything a session surfaces from its declared plugins, ready for the compose
 * override.
 *
 * Never throws and never fails a session: a plugin whose fragment cannot be used
 * contributes no services and one issue on its repository's card, and the
 * project's own stack comes up exactly as it would have (reqs 13, 14).
 */
export async function resolveSessionPluginServices(
  sessionId: string,
  workspaceDir: string,
  deps: PluginServiceDeps,
): Promise<PluginComposeService[]> {
  let config: ShipitConfig;
  try {
    config = resolveShipitConfig(workspaceDir);
  } catch {
    return [];
  }
  if (!config.plugins.declared || config.plugins.uses.length === 0) {
    recordPluginServiceFailures(sessionId, new Map());
    return [];
  }

  let stateDir: string;
  let sessionDir: string;
  try {
    stateDir = sessionStateDirForWorkspace(workspaceDir);
    sessionDir = sessionRootForWorkspace(workspaceDir);
  } catch {
    return []; // a session layout with no state dir has no generations either
  }

  const project = readProjectServices(workspaceDir, config, deps.containEgress);
  const { services: fragments } = collectPluginFragments({
    workspaceDir,
    stateDir,
    plugins: config.plugins,
    selfExports: config.pluginExports,
    projectServiceNames: project.names,
    containEgress: deps.containEgress,
  });
  if (fragments.length === 0) {
    recordPluginServiceFailures(sessionId, new Map());
    return [];
  }

  const roots = deps.docker
    ? await resolvePluginOverlayRoots(deps.docker, deps.workspaceVolume, deps.stateRoot)
    : {};
  const pluginVolumes = await ensurePluginVolumes(sessionId, stateDir, fragments, deps, roots);

  // req 18 — pinned per (session, service). Project ports are reserved: theirs
  // is both an origin and a real container port, so of the two only a plugin's
  // is ShipIt's to move.
  const publishedPorts = resolvePublishedPorts(
    sessionDir,
    fragments.map((f) => ({
      service: f.name,
      ...(f.port !== undefined ? { containerPort: f.port } : {}),
    })),
    project.ports,
  );

  const built = buildPluginComposeServices(fragments, {
    sessionDir,
    sessionDirDaemon: toDaemonPath(sessionDir, roots),
    workspaceDir,
    ...(deps.workspaceVolume ? { workspaceVolume: deps.workspaceVolume } : {}),
    ...(workspaceSubpath(workspaceDir, deps) ? { workspaceSubpath: workspaceSubpath(workspaceDir, deps)! } : {}),
    pluginVolumes,
    publishedPorts,
  });
  recordPluginServiceFailures(sessionId, built.issuesByRepo);
  return built.services;
}

/**
 * This session's subpath inside the workspace volume — the same derivation
 * `setupServiceManager` makes for the project's own services, kept here so the
 * two cannot disagree about where a session's files sit inside that volume.
 */
function workspaceSubpath(workspaceDir: string, deps: PluginServiceDeps): string | undefined {
  if (!deps.workspaceVolume) return undefined;
  return workspaceDir.replace(/^\/workspace\//, "");
}

/**
 * The project's own service names and ports, best-effort.
 *
 * Best-effort because this is a *collision domain*, not a gate: a project whose
 * compose file is mid-edit (or absent — a project may declare plugins and no
 * stack of its own) should still get its plugin services. Its own stack reports
 * the parse failure through its own path.
 */
function readProjectServices(
  workspaceDir: string,
  config: ShipitConfig,
  containEgress: boolean,
): { names: string[]; ports: Set<number> } {
  if (!config.compose) return { names: [], ports: new Set() };
  try {
    const parsed = parseComposeFile(path.join(workspaceDir, config.compose.file), {
      dockerSocket: config.compose.dockerSocket,
      containEgress,
    });
    const ports = new Set<number>();
    for (const svc of parsed) {
      for (const mapping of svc.ports ?? []) {
        const segments = mapping.split("/")[0].split(":");
        const port = Number.parseInt(segments[segments.length - 1], 10);
        if (Number.isInteger(port)) ports.add(port);
      }
    }
    return { names: parsed.map((s) => s.name), ports };
  } catch {
    return { names: [], ports: new Set() };
  }
}

/**
 * Make sure every tracked repository with services has its live generation's
 * overlay volume, and return the ones that are usable.
 *
 * A repository that does not get one is left out of the map, and
 * `buildPluginComposeServices` drops its services with a reason — running a
 * plugin against a tree that is missing whatever its `install` produced is the
 * partial state req 15 forbids, dressed up as a working service.
 */
async function ensurePluginVolumes(
  sessionId: string,
  stateDir: string,
  fragments: readonly PluginFragmentService[],
  deps: PluginServiceDeps,
  roots: { volumeMountpoint?: string; stateRoot?: string },
): Promise<Map<string, string>> {
  const volumes = new Map<string, string>();
  const docker = deps.docker;
  if (!docker) return volumes;

  const tracked = new Map<string, string>();
  for (const fragment of fragments) {
    if (!fragment.self && fragment.commit) tracked.set(fragment.repo, fragment.commit);
  }

  for (const [repoName, commit] of tracked) {
    try {
      // The REAL generation directory, not the `active` symlink: it is the
      // overlay's lowerdir, and the daemon-path translation below is a string
      // rewrite that cannot follow a link.
      const checkoutDir = await fsp.realpath(activeLinkPath(stateDir, repoName));
      const spec = buildPluginOverlaySpec({
        sessionId,
        repoName,
        commit,
        stateDir,
        checkoutDir,
        ...roots,
      });
      if (!(await volumeExists(docker, spec.volumeName))) {
        await prepareRuntimeLayer(spec);
        await createPluginOverlay(docker, spec);
      }
      volumes.set(repoName, spec.volumeName);
      await dropSupersededVolumes(docker, sessionId, repoName, spec.volumeName);
    } catch (err) {
      console.warn(
        `[plugins:${sessionId}] ${repoName}: could not prepare the plugin's runtime layer:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return volumes;
}

/**
 * Give the runtime mount what overlayfs demands, WITHOUT touching the upper
 * layer: that is where `install` wrote, and this is the mount whose whole
 * purpose is to merge it over the checkout. Only the workdir is reset — it is
 * the kernel's own scratch space and holds nothing anybody wrote.
 */
async function prepareRuntimeLayer(spec: PluginOverlaySpec): Promise<void> {
  await fsp.mkdir(spec.orchDirs.upperdir, { recursive: true });
  await fsp.rm(spec.orchDirs.workdir, { recursive: true, force: true });
  await fsp.mkdir(spec.orchDirs.workdir, { recursive: true });
  // Plugin services run as the session-worker uid; the orchestrator is root.
  chownToSessionWorker(path.dirname(spec.orchDirs.upperdir));
  chownToSessionWorker(spec.orchDirs.upperdir);
  chownToSessionWorker(spec.orchDirs.workdir);
}

/**
 * Drop this repository's volumes from superseded generations.
 *
 * A refresh publishes a new commit and therefore a new volume name (they are
 * per generation — a volume's driver options are fixed while consumers hold it),
 * so without this every refresh would leave one behind for the rest of the
 * session. Best-effort: one still held by a container that has not been
 * recreated yet is removed on the next round, and the disk janitor's orphan
 * sweep is the backstop for a session that goes away first.
 */
async function dropSupersededVolumes(
  docker: Docker,
  sessionId: string,
  repoName: string,
  keep: string,
): Promise<void> {
  // The generation suffix is the last name component, so everything before it
  // identifies (session, repository) exactly — including the hash that
  // disambiguates two repo names the volume-name rendering flattens together.
  const prefix = keep.slice(0, keep.lastIndexOf("-") + 1);
  const listed = await docker.listVolumes({ filters: { name: [prefix] } });
  for (const volume of listed.Volumes ?? []) {
    if (volume.Name === keep || !volume.Name.startsWith(prefix)) continue;
    const released = await removePluginOverlay(docker, volume.Name);
    if (!released) {
      console.log(`[plugins:${sessionId}] ${repoName}: ${volume.Name} is still held — leaving it for the next round`);
    }
  }
}
