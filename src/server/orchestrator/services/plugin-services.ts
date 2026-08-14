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
import { ensurePluginRuntimeOverlay, resolvePluginOverlayRoots } from "../plugin-overlay.js";
import { holdGenerationsForOwner, pluginServiceOwner } from "../plugin-leases.js";
import { resolveLiveGenerations } from "../plugin-generations.js";
import { resolvePublishedPorts } from "../plugin-ports.js";
import { sessionRootForWorkspace, volumeSubpathFor } from "../plugin-state.js";
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
 *
 * **Every path that decides this session surfaces no plugin services also lets
 * go of its generation holds** ({@link nothingToSurface}), because a hold that is
 * only released on the happy path is the leak req 15's lease was built to avoid.
 * The one exception is a `shipit.yaml` this function cannot read at all: that is
 * not evidence that the plugins went away, the services from the previous round
 * are still running against their generations, and the next readable round
 * replaces the set. A session disposal releases them either way
 * (`clearActivationState`).
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
    return nothingToSurface(sessionId);
  }

  let stateDir: string;
  let sessionDir: string;
  try {
    stateDir = sessionStateDirForWorkspace(workspaceDir);
    sessionDir = sessionRootForWorkspace(workspaceDir);
  } catch {
    // A session layout with no state dir has no generations either.
    return nothingToSurface(sessionId);
  }

  const project = readProjectServices(workspaceDir, config, deps.containEgress);
  const { services: fragments } = collectPluginFragments({
    workspaceDir,
    // One resolution per repository for this build, so a fragment and the tree
    // its services mount cannot come from two generations (docs/262).
    live: resolveLiveGenerations(stateDir, config.plugins.repos),
    plugins: config.plugins,
    selfExports: config.pluginExports,
    projectServiceNames: project.names,
    containEgress: deps.containEgress,
  });
  if (fragments.length === 0) return nothingToSurface(sessionId);

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

  const sessionSubpath = volumeSubpath(sessionDir, deps);
  const workspaceSubpath = volumeSubpath(workspaceDir, deps);
  const built = buildPluginComposeServices(fragments, {
    sessionDir,
    ...(sessionSubpath ? { sessionSubpath } : {}),
    workspaceDir,
    ...(deps.workspaceVolume ? { workspaceVolume: deps.workspaceVolume } : {}),
    ...(workspaceSubpath ? { workspaceSubpath } : {}),
    pluginVolumes,
    publishedPorts,
  });
  recordPluginServiceFailures(sessionId, built.issuesByRepo);
  return built.services;
}

/**
 * The answer for a session with no plugin services this round: last round's
 * failures are cleared, and every generation this surface was holding is
 * released so a later prune can reclaim it (req 15).
 */
function nothingToSurface(sessionId: string): PluginComposeService[] {
  recordPluginServiceFailures(sessionId, new Map());
  holdGenerationsForOwner(pluginServiceOwner(sessionId), []);
  return [];
}

/**
 * This session's subpath inside the workspace volume, and the session ROOT's —
 * `plugin-data/` is a sibling of `workspace/`, so it needs its own rather than
 * one derived from the clone's.
 *
 * Both go through {@link volumeSubpathFor}, the same translation the companion
 * CLI's container mounts take, keyed off the orchestrator-visible `stateRoot`
 * that maps onto the volume's root. Taking it from `stateRoot` rather than
 * stripping a literal `/workspace/` is what makes the two surfaces one
 * derivation instead of two that agree by coincidence — and it is why this
 * returns `undefined` for a path the root does not contain, which the mount
 * builder turns into a dropped service with a reason rather than a bind of a
 * path the daemon cannot see.
 */
function volumeSubpath(dir: string, deps: PluginServiceDeps): string | undefined {
  if (!deps.workspaceVolume || !deps.stateRoot) return undefined;
  return volumeSubpathFor(deps.stateRoot, dir) ?? undefined;
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
 *
 * **This is where the service surface takes its half of the consumer lease**
 * (`plugin-leases.ts`, req 15). A plugin service container outlives the call
 * that created it, so its lease has two parts: the container's own attachment to
 * the generation volume — which the daemon enforces, and which is the only fact
 * that survives an orchestrator restart — and the in-process hold taken here,
 * covering the window before that container exists, where the volume is created
 * but attached to nothing and a concurrent refresh's prune would take it away.
 *
 * The hold set is REPLACED each round rather than added to, so it follows a
 * refresh with no release call of its own: a repository whose generation moved,
 * whose services went away, or which is no longer declared simply is not in the
 * set this round and is let go. That is also why superseded volumes are no
 * longer swept from here — deleting a generation's volume is now part of taking
 * the lease to delete the generation itself (`plugin-generations.ts`'s prune),
 * and a second sweeper racing the pruner on one volume name is precisely the
 * "two mechanisms" this lease exists to avoid.
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

  const tracked = new Map<string, { commit: string; checkoutDir: string }>();
  for (const fragment of fragments) {
    if (!fragment.self && fragment.commit) {
      tracked.set(fragment.repo, { commit: fragment.commit, checkoutDir: fragment.checkoutDir });
    }
  }

  // Taken even without Docker, so the hold set is released for a session whose
  // declaration dropped its plugin services either way.
  const held = new Set(
    holdGenerationsForOwner(
      pluginServiceOwner(sessionId),
      [...tracked].map(([repoName, { commit }]) => ({ sessionId, repoName, commit })),
    ).map((ref) => ref.repoName),
  );
  if (!docker) return volumes;

  for (const [repoName, { commit, checkoutDir }] of tracked) {
    if (!held.has(repoName)) {
      // The generation is being pruned right now, which means it has already
      // been superseded — this round is looking at a version that is on its way
      // out. Leaving it out of the map drops its services with a reason, and the
      // round the newer generation settles brings them back.
      console.warn(
        `[plugins:${sessionId}] ${repoName}: ${commit.slice(0, 9)} is being replaced — leaving its services out of this round`,
      );
      continue;
    }
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
    } catch (err) {
      console.warn(
        `[plugins:${sessionId}] ${repoName}: could not prepare the plugin's runtime layer:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return volumes;
}
