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
  ensurePluginRuntimeOverlay,
  removePluginOverlay,
  resolvePluginOverlayRoots,
} from "../plugin-overlay.js";
import { resolvePublishedPorts } from "../plugin-ports.js";
import { sessionRootForWorkspace } from "../plugin-state.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";
import { resolveShipitConfig, type ShipitConfig } from "../../shared/shipit-config.js";
import { recordPluginServiceFailures } from "./plugin-activation.js";

export interface PluginServiceDeps {
  /** Absent where there is no Docker (local/dogfood mode, tests). */
  docker?: Docker;
  /**
   * Name of the workspace volume, and the orchestrator root that maps onto it.
   *
   * The caller reads this from the container manager, which is where the
   * daemon-path translation `plugin-install.ts` already takes it from — and it
   * is the same `WORKSPACE_VOLUME` that `setupServiceManager` hands the
   * ServiceManager, so a plugin service's `shipit-workspace` mount and the
   * override's declaration of that volume can only be present together.
   */
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
  //
  // Only services that DECLARE a port ask for one. A worker with no `ports:` is
  // not previewable, and handing it a band number would make the client — which
  // treats any running service with a port as previewable — offer an origin
  // that resolves to nothing (review finding).
  const publishedPorts = resolvePublishedPorts(
    sessionDir,
    fragments
      .filter((f) => f.port !== undefined)
      .map((f) => ({ service: f.name, containerPort: f.port! })),
    project.ports,
  );

  const built = buildPluginComposeServices(fragments, {
    sessionDir,
    ...(sessionSubpath(sessionDir, deps) ? { sessionSubpath: sessionSubpath(sessionDir, deps)! } : {}),
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
 * The same, for the session ROOT — `plugin-data/` is a sibling of `workspace/`,
 * so it needs its own subpath rather than one derived from the clone's.
 */
function sessionSubpath(sessionDir: string, deps: PluginServiceDeps): string | undefined {
  if (!deps.workspaceVolume) return undefined;
  return sessionDir.replace(/^\/workspace\//, "");
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

  const tracked = new Map<string, { commit: string; checkoutDir: string }>();
  for (const fragment of fragments) {
    if (!fragment.self && fragment.commit) {
      tracked.set(fragment.repo, { commit: fragment.commit, checkoutDir: fragment.checkoutDir });
    }
  }

  for (const [repoName, { commit, checkoutDir }] of tracked) {
    try {
      // `checkoutDir` is the ALREADY-RESOLVED generation the fragment and the
      // commit were read from — resolving `active` again here is how a volume
      // named for one commit ends up with another commit's lowerdir.
      // ENSURE, not create. The CLI invocation container asks for the same
      // volume, and the kernel forbids one upperdir backing two independently
      // created overlay mounts — so there is exactly one creator, shared
      // (`plugin-overlay.ts`), and both surfaces attach what it returns.
      const volumeName = await ensurePluginRuntimeOverlay(docker, {
        sessionId,
        repoName,
        commit,
        stateDir,
        checkoutDir,
        ...roots,
      });
      volumes.set(repoName, volumeName);
      await dropSupersededVolumes(docker, sessionId, repoName, volumeName);
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
