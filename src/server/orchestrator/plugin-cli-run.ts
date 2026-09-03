/**
 * docs/262 req 17 — run one imported plugin's companion CLI, in a container
 * that holds only what that plugin declared.
 *
 * **The boundary is the point, and it is `install`'s boundary** (plan §1b/§2).
 * A generated wrapper on the agent's PATH is ShipIt's own script; the command
 * itself never runs beside the wrapper, because the agent container can reach
 * the worker's loopback credential broker (`/agent-ops/*`, which needs no
 * token) and would therefore hand any plugin a real GitHub token. Req 19 holds
 * here by construction: this container has no `/credentials`, no worker URL, no
 * session network, and nothing from the orchestrator process's environment. (The
 * borrowed image's own `ENV` is inherited — Docker merges over it and cannot
 * unset it — so its worker-owned paths are overridden by
 * `plugin-container-env.ts`.)
 *
 * What it DOES hold is exactly the in-session usage contract:
 *
 *  - `/plugin` — the generation's overlay volume, the pristine checkout merged
 *    with its install output, mounted **read-only**: a generation is what req 15
 *    says every surface of that repository corresponds to, and `install` — which
 *    runs before the generation is published — is its one writer (req 7,
 *    `plugin-compose.ts`'s `pluginTreeMount` states the whole rule). Under
 *    `repo: self` (req 27) it is the session's own working tree instead, mounted
 *    read-write, because there the plugin is deliberately live and editable and
 *    the same tree is `/project` anyway. The tracked case takes the **consumer
 *    lease** (`plugin-leases.ts`, req 15) for the whole call, so a refresh
 *    landing mid-command cannot delete the checkout this container is running
 *    from — it is the same lease a plugin service takes, because both attach the
 *    same per-generation volume.
 *  - `/project` — the consuming project's workspace (req 21), and the cwd, so a
 *    cwd-addressed tool behaves as it would have beside the agent. A plugin's
 *    durable output lands here as ordinary project changes (req 18).
 *  - `/plugin-state` — this import's shared state directory, the one writable
 *    surface that is neither project data nor plugin source, and the thing that
 *    makes "the CLI and the UI work on the same live state" true (reqs 17, 18).
 *  - `/plugin-settings.json` — read-only, when the import has validated
 *    settings (req 26).
 *  - the plugin's **declared** credential names, resolved from the consuming
 *    project's own secret store, and nothing else from it (req 23).
 *
 * **And it reaches only what the session reaches** (req 24, `plugin-egress.ts`).
 * On a contained session the container runs in the namespace of a ShipIt-owned
 * holder that already carries the Tier A/B/C stack, configured from the session's
 * own `resolveEgress` — so a companion CLI's outbound reach equals the agent's,
 * and the Plugins card's declared-host report describes what actually happens.
 * The holder lives on the same untrusted plugin network, so req 19's API denial
 * is unchanged; sharing a SESSION container's namespace would break it, which is
 * why this is containment of its own rather than the session's.
 *
 * **Collisions are re-checked here, not trusted from the wrapper** (req 20).
 * The wrapper is a file on a container filesystem and a declaration can change
 * under it; the requirement is that ShipIt reports the collision *before
 * running the ambiguous one*, so the run boundary re-derives the same plan and
 * refuses with the same message.
 *
 * The recheck covers the two domains this side can know — a name two imports
 * claim, and a name ShipIt reserves. It does NOT re-run the **PATH** probe: the
 * PATH that matters belongs to the agent container, which the orchestrator
 * cannot see. That domain is enforced where it is knowable, by the wrapper
 * generator refusing to write the file (`session/plugin-cli.ts`); a shadowing
 * name therefore never becomes a wrapper, and normal shell lookup runs the
 * program that was already there. What is left uncovered is a direct
 * `shipit plugin exec` for such a name, which is not the ambiguity req 20 is
 * about — nothing there is ambiguous, the caller named one import explicitly.
 *
 * Output is **buffered**, not streamed. Two hops of NDJSON relaying is real
 * machinery, and the plan already accepts per-call latency here ("a
 * credential-blind persistent runner is a later optimisation"). The cost is
 * that a long command shows nothing until it exits; the cap below is what keeps
 * that from becoming a memory problem.
 */

import fs from "node:fs";
import path from "node:path";
import type Docker from "dockerode";
import { PassThrough, type Duplex } from "node:stream";
import {
  CONTAINER_PLUGIN_DIR,
  CONTAINER_PLUGIN_SETTINGS_FILE,
  CONTAINER_PLUGIN_STATE_DIR,
  CONTAINER_PROJECT_DIR,
  PLUGIN_COMMIT_ENV,
  PLUGIN_PROJECT_ENV,
  PLUGIN_SETTINGS_ENV,
  PLUGIN_STATE_ENV,
} from "../shared/plugin-contract.js";
import { CONTAINER_WORKSPACE_DIR } from "../shared/fs-constants.js";
import { planPluginCommands } from "../shared/plugin-cli.js";
import type { PluginExport } from "../shared/plugin-repos.js";
import { destinationKey } from "../shared/plugin-repos.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import {
  activeLinkPath,
  generationIdFor,
  readGenerationManifestAt,
  readGenerationRecordAt,
} from "./plugin-generations.js";
import { ensureUntrustedPluginNetwork, waitForContainerExit } from "./plugin-container.js";
import { pluginContainerEnv } from "./plugin-container-env.js";
import {
  preparePluginNetns,
  UNCONTAINED_PLUGIN_EGRESS,
  type PluginEgressPolicy,
  type PluginNetns,
} from "./plugin-egress.js";
import { holdGeneration, type ReleaseHold } from "./plugin-leases.js";
import { assertOverlayVolumesMatch } from "./overlay-volume.js";
import {
  ensurePluginRuntimeOverlay,
  pluginRuntimeOverlaySpec,
  resolvePluginOverlayRoots,
  type PluginOverlaySpec,
} from "./plugin-overlay.js";
import { resolveLiveGenerations } from "./plugin-generations.js";
import {
  createPluginImportResolver,
  pluginSettingsPath,
  pluginStateDir,
  sessionRootForWorkspace,
  volumeSubpathFor,
} from "./plugin-state.js";
import { loadSatisfiedPluginCredentialNames } from "./plugin-credentials.js";
import type { SecretStore } from "./secret-store.js";
import { sessionStateDirForWorkspace } from "./session-state-dir.js";
import { chownToSessionWorker, identityForSession } from "./session-worker-uid.js";

/**
 * Dedicated network for CLI invocation containers — separate from install's,
 * so the two are independently deniable and a rule change to one cannot widen
 * the other. See `plugin-container.ts` for why it is not the default
 * bridge and not the session's network.
 */
export const PLUGIN_CLI_NETWORK = "shipit-plugin-cli";

/** Stamped on the container so an orphan is identifiable and sweepable. */
export const PLUGIN_CLI_LABEL = "shipit-plugin-cli";

/**
 * How long one companion-CLI call may run. Generous, because a companion CLI is
 * a real program — but bounded, because the shim's transport is deliberately
 * unbounded and a hung command would otherwise hold an agent turn open forever.
 */
export const DEFAULT_PLUGIN_CLI_TIMEOUT_MS = 15 * 60_000;

/** Memory ceiling, matching the install container's order of magnitude. */
const CLI_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const CLI_PIDS_LIMIT = 512;
/** Per-stream output cap. Buffered output cannot be unbounded. */
const MAX_STREAM_BYTES = 8 * 1024 * 1024;

export interface PluginCliDeps {
  docker: Docker;
  /** The session-worker image, for its toolchain — its ENTRYPOINT is bypassed. */
  image: string;
  sessionId: string;
  workspaceDir: string;
  /** The consuming project's remote — the secret store is keyed by it (req 23). */
  consumerRepoUrl: string | null;
  /**
   * The consuming project's secret store. Typed as the load method alone, the
   * same narrowing `plugin-credentials.ts` uses, so no caller can pass a store
   * that knows about ShipIt's own credentials — `CredentialStore` (the GitHub
   * token, tracker tokens, agent routes) does not fit this parameter.
   */
  secretStore?: Pick<SecretStore, "loadSecrets">;
  /** Volume name + orchestrator-visible state root; both omitted in dev/dogfood. */
  workspaceVolume?: string;
  stateRoot?: string;
  /**
   * req 28 — the orchestrator state dir holding the shared dependency store,
   * where a generation's pinned bases resolve. Unlike the pair above it is not
   * about daemon-path translation, so it is present whenever there is a store.
   */
  depStoreDir?: string;
  /**
   * docs/183 — this session's overlay dep-dir volumes, resolved at CALL time.
   *
   * They are what makes a mount of the working tree show the dependencies
   * `agent.install` produced: on an overlay-backed session the clone's
   * `node_modules` is an empty mount point and the content lives only in these
   * volumes, which the agent container and the project's own compose services
   * attach. An invocation container attached neither, so `/project` — and,
   * under `repo: self`, `/plugin` with it — held an empty directory where the
   * plugin's own dependencies should be, and no entry point could start
   * (nikzlabs/shipit#2298).
   *
   * A thunk for the reason `egress` is one: a companion CLI can be invoked long
   * after the session opened, and the volumes are created with the agent
   * container. Absent in dev, in local mode and in tests — all places where
   * there is no overlay and nothing to nest.
   *
   * **It reads back what the agent container actually mounted** (#2426), and
   * re-derives from `shipit.yaml` only when there is no container record to
   * read. That reverses an earlier decision here, so the reversal is recorded
   * rather than quietly made: this doc used to state that re-derivation was
   * reviewed and accepted because nothing exposed the container's mounts, and
   * because a value resolved once would "stay wrong for good" while a
   * re-derivation at least converges on the container's next recreate.
   *
   * Both halves of that premise have expired. `provisionedOverlayDepDirs`
   * exposes the mounts, and it is scoped to the CONTAINER rather than the
   * session — a recreate rebuilds it from the new specs, so it converges on
   * precisely the event the old argument relied on, while ALSO agreeing with
   * the agent in between. The live workspace does not: flipping the pnpm
   * signals mid-session (a `pnpm-lock.yaml` lands) makes the re-derivation
   * answer `[]` for a session whose agent container still holds live overlays,
   * which restores the empty `/project/node_modules` this whole mechanism
   * exists to remove. See `resolveSiblingOverlayDepDirs`.
   */
  overlayDepDirs?: () => Promise<readonly { depDir: string; volumeName: string }[]>;
  timeoutMs?: number;
  /**
   * docs/262 req 24 — this session's egress posture, read at CALL time.
   *
   * A thunk rather than a value for the reason `createStagedGenerationGate`
   * takes one: a companion CLI can be invoked half an hour after the session
   * opened, after the user has granted a host or flipped the session to Open,
   * and the container must be built against the posture that holds now. Absent
   * only where there is no container manager (local mode, tests), which is also
   * where there is no invocation container.
   */
  egress?: () => PluginEgressPolicy;
  /**
   * Whether the session this call belongs to is gone (archived, reset,
   * disposed). Without it the `"cancelled"` branch below is unreachable and a
   * hung command keeps its project and state mounts, and its network, for the
   * full timeout after the session it served stopped existing — which is
   * precisely why `install` takes the same hook (review finding).
   */
  isCancelled?: () => boolean;
}

export interface PluginCliRequest {
  /** The `use:` entry's alias — the import, not the plugin. */
  alias: string;
  /** The command as the plugin's manifest declares it (pre-rename). */
  command: string;
  args: string[];
  /** The wrapper's working directory in the agent container. */
  cwd?: string;
  stdin?: string;
}

export interface PluginCliResult {
  /** Set when ShipIt refused to run — a bad alias, a collision, no generation. */
  error?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one command. Returns a result rather than throwing: every failure here is
 * something the agent needs to read, and an exception would reach it as an
 * opaque 500 with the reason in the orchestrator's log.
 */
export async function runPluginCommand(
  deps: PluginCliDeps,
  req: PluginCliRequest,
): Promise<PluginCliResult> {
  // docs/262 req 15 — the consumer lease. Taken inside {@link pinGeneration}, in
  // the same synchronous block that resolves `active`, and released here on
  // EVERY path: a refusal, a daemon error, a timeout, a cancelled session. A
  // lease with more than one exit is a lease that leaks, so the hold lives out
  // here and the work lives in a function that cannot skip this `finally`.
  const held: { release?: ReleaseHold } = {};
  try {
    return await runHeldPluginCommand(deps, req, held);
  } finally {
    held.release?.();
  }
}

async function runHeldPluginCommand(
  deps: PluginCliDeps,
  req: PluginCliRequest,
  held: { release?: ReleaseHold },
): Promise<PluginCliResult> {
  const refuse = (error: string): PluginCliResult => ({ error, exitCode: 126, stdout: "", stderr: "" });

  let stateDir: string;
  let sessionRoot: string;
  try {
    stateDir = sessionStateDirForWorkspace(deps.workspaceDir);
    sessionRoot = sessionRootForWorkspace(deps.workspaceDir);
  } catch (err) {
    return refuse(`this session has no plugin state directory: ${message(err)}`);
  }

  const config = resolveShipitConfig(deps.workspaceDir);
  const use = config.plugins.uses.find((u) => u.alias.toLowerCase() === req.alias.toLowerCase());
  if (!use) {
    return refuse(`\`${req.alias}\` is not a plugin this project imports (check \`plugins.use\` in shipit.yaml).`);
  }
  // The OTHER repositories' manifests, for the collision verdict only. One
  // resolution each for this invocation; the target repository is pinned
  // separately below, because that pin also names the volume and the lowerdir.
  // "Other" holds because the lookup resolves a repository on first ask and
  // nothing here ever asks it about the target: `repoNameFor` reads the
  // declaration alone, and every manifest read for the target goes through
  // `pinned.exports`. Keep it that way — routing the target back through the
  // resolver would follow its `active` a second time, which is the skew this
  // whole path exists to prevent.
  const resolver = createPluginImportResolver(
    config.plugins,
    config.pluginExports,
    resolveLiveGenerations(stateDir, config.plugins.repos),
  );
  const repoName = resolver.repoNameFor(use);
  if (!repoName) {
    return refuse(`\`${req.alias}\` has no live plugin version right now — refresh it, or check the Plugins tab.`);
  }
  const repo = config.plugins.repos.find((r) => r.name === repoName);
  const isSelf = repo?.source.kind === "self";

  // **Resolve `active` exactly ONCE, here, and read every fact about the live
  // generation out of that one answer** (sibling report, docs/262). Docker
  // resolves a bind source and a `volume.subpath` at container-CREATION time,
  // and each of `readActiveManifest`, `readActiveGeneration` and a `realpath`
  // for the lowerdir follows the symlink independently — so a refresh landing
  // between them produced an entrypoint from generation A, a
  // `SHIPIT_PLUGIN_COMMIT` and volume NAME from B, and a lowerdir from C. That
  // last pair is the damaging one: a volume named for B whose lower tree is C's
  // and whose writable layer is B's, left on disk under B's name for every
  // later caller. Pinning the directory first makes the whole call describe one
  // generation or fail.
  let pinned: PinnedGeneration | null = null;
  if (!isSelf) {
    // Invariant, not a case: `repoNameFor` returns the NAME of a declared repo,
    // so the lookup above cannot miss. Asserted rather than assumed because the
    // next line needs its source, and reading a source off the wrong entry is
    // the failure this whole path exists to prevent.
    if (!repo) {
      return refuse(`\`${repoName}\` is not a declared plugin repository in this project.`);
    }
    try {
      pinned = pinGeneration(deps.sessionId, stateDir, repoName, destinationKey(repo.source));
    } catch (err) {
      return refuse(`\`${repoName}\`'s active checkout could not be resolved: ${message(err)}`);
    }
    if (pinned) held.release = pinned.release;
    if (!pinned) {
      return refuse(`\`${repoName}\` has no active version in this session yet — run \`shipit plugin refresh ${repoName}\`.`);
    }
  }

  // For THIS repository the manifest comes from the pinned directory, never
  // from a fresh symlink read — the entrypoint the container runs and the tree
  // it is mounted from have to be the same generation. Other repositories keep
  // the resolver: they contribute only to the collision verdict below, where a
  // slightly older read cannot corrupt a mount.
  const exported = pinned
    ? pinned.exports.find((e) => e.name.toLowerCase() === use.plugin.toLowerCase()) ?? null
    : resolver.exportFor(use);
  if (!exported) {
    return refuse(`\`${req.alias}\` has no live plugin version right now — refresh it, or check the Plugins tab.`);
  }

  // req 20, at the run boundary. The wrapper that called us is a file, and the
  // declaration may have changed since it was written; the requirement is that
  // an ambiguous name is reported rather than run. No `isTaken` — see the
  // module docstring: the PATH that matters is the agent container's.
  const plan = planPluginCommands(config.plugins.uses, (u) => {
    const uRepo = resolver.repoNameFor(u);
    if (pinned && uRepo === repoName) {
      return {
        repo: uRepo,
        exported: pinned.exports.find((e) => e.name.toLowerCase() === u.plugin.toLowerCase()) ?? null,
      };
    }
    return { repo: uRepo, exported: resolver.exportFor(u) };
  });
  const surfaced = plan.commands.find(
    (c) => c.alias.toLowerCase() === use.alias.toLowerCase()
      && c.declared.toLowerCase() === req.command.toLowerCase(),
  );
  if (!surfaced) {
    const issues = plan.issues.get(repoName) ?? [];
    return refuse(
      issues.length > 0
        ? issues.join("\n")
        : `\`${req.command}\` is not a command \`${exported.name}\` exports.`,
    );
  }

  // The plugin's own tree. Tracked: the generation's overlay volume, so the CLI
  // sees the SAME merged checkout+install-output the installer produced —
  // read-ONLY, like the service that attaches the same volume. Self: the working
  // tree itself, live and writable — req 27's whole point.
  const mounts: MountSpec[] = [];
  // Collected rather than thrown, so ONE refusal names the first untranslatable
  // path instead of an exception reaching the agent as an opaque 500. See
  // {@link sessionPathMount} for why there is no bind to fall back to.
  const mountErrors: string[] = [];
  const addSessionMount = (hostPath: string, target: string, readOnly: boolean): void => {
    try {
      mounts.push(sessionPathMount(deps, hostPath, target, readOnly));
    } catch (err) {
      mountErrors.push(message(err));
    }
  };
  // Where the session's overlay dep dirs are nested below, and it is empty for a
  // tracked import — see {@link PluginCliDeps.overlayDepDirs} and the same rule
  // stated for services in `compose-generator.ts`.
  const workspaceTreeTargets: string[] = [];
  let commit: string | null = null;
  let overlaySpec: PluginOverlaySpec | undefined;
  if (!pinned) {
    addSessionMount(deps.workspaceDir, CONTAINER_PLUGIN_DIR, false);
    // req 27 — under `repo: self` the working tree is BOTH of these, and the
    // dependencies the plugin's own entry point loads are the project's.
    workspaceTreeTargets.push(CONTAINER_PLUGIN_DIR, CONTAINER_PROJECT_DIR);
  } else {
    commit = pinned.commit;
    try {
      const roots = await resolvePluginOverlayRoots(deps.docker, deps.workspaceVolume, deps.stateRoot);
      const overlayArgs = {
        sessionId: deps.sessionId,
        repoName,
        // Both from the SAME pinned directory, so the volume's name and its
        // lowerdir can never describe two different generations.
        generationId: pinned.generationId,
        stateDir,
        checkoutDir: pinned.dir,
        // req 28 — the shared dependency bases this generation pins are read out
        // of that same pinned directory, so the volume's lowerdir stack cannot
        // describe two generations either.
        ...(deps.depStoreDir ? { depStoreDir: deps.depStoreDir } : {}),
        ...roots,
      };
      overlaySpec = pluginRuntimeOverlaySpec(overlayArgs);
      const volume = await ensurePluginRuntimeOverlay(deps.docker, overlayArgs);
      // A NAMED volume, so it needs no path translation: the daemon already
      // knows where it is, which is exactly why install could get away with one
      // bind and this cannot.
      //
      // **Read-only, and this is the surface that used to get it wrong.** The
      // volume is the SAME one the plugin's services attach, and they have had it
      // read-only from the start; a writable CLI mount meant a command could
      // copy-up into the generation's layer and change the code its own services
      // were running, for the rest of the session, under a
      // `SHIPIT_PLUGIN_COMMIT` that no longer described it (reqs 7, 15). Only
      // `install` writes a generation, and it does so before publication.
      mounts.push({ Type: "volume", Source: volume, Target: CONTAINER_PLUGIN_DIR, ReadOnly: true });
    } catch (err) {
      return refuse(`\`${repoName}\`'s plugin tree could not be prepared: ${message(err)}`);
    }
  }

  // The import's state directory. Normally already there (a prepare pass runs
  // at the end of every activation round), but created here too: a CLI call is
  // allowed to be the first thing that happens in a session, and an absent
  // directory would otherwise appear inside the plugin as a bind mount Docker
  // created as root — unwritable, for a reason nothing explains.
  const hostStateDir = pluginStateDir(sessionRoot, use.alias);
  try {
    fs.mkdirSync(hostStateDir, { recursive: true });
    chownToSessionWorker(hostStateDir);
  } catch (err) {
    return refuse(`\`${use.alias}\`'s shared state directory could not be prepared: ${message(err)}`);
  }

  const hostSettings = pluginSettingsPath(sessionRoot, use.alias);
  const hasSettings = fs.existsSync(hostSettings);

  addSessionMount(deps.workspaceDir, CONTAINER_PROJECT_DIR, false);
  addSessionMount(hostStateDir, CONTAINER_PLUGIN_STATE_DIR, false);
  if (hasSettings) {
    // As a FILE, which the daemon supports: it stats the resolved path and binds
    // a file as a file (`daemon/volume/safepath/join_linux.go`), from API 1.45 —
    // below the floor docs/263 already requires. Mounting its parent instead
    // would hand the plugin a directory it can write, and settings a plugin can
    // rewrite were never validated.
    addSessionMount(hostSettings, CONTAINER_PLUGIN_SETTINGS_FILE, true);
  }
  // docs/183 — nest this session's overlay dep dirs under the working-tree
  // mounts, so `/plugin` and `/project` hold the dependencies the agent
  // container sees rather than the empty mount point they are on the volume.
  //
  // A failure to resolve them degrades rather than refusing, and that is a
  // deliberate choice with a cost: under `repo: self` it restores exactly the
  // empty `node_modules` this exists to fix, so a plugin with dependencies fails
  // on its own import instead of on a sentence from ShipIt. It is still the
  // better of the two, because the alternative withholds every companion CLI in
  // the session — including the many that have no dependencies at all — over a
  // daemon hiccup. The log line below is the thing that makes the import error
  // diagnosable, so it must stay.
  try {
    for (const { depDir, volumeName } of (await deps.overlayDepDirs?.()) ?? []) {
      for (const target of workspaceTreeTargets) {
        mounts.push({
          Type: "volume",
          Source: volumeName,
          Target: path.posix.join(target, depDir),
        });
      }
    }
  } catch (err) {
    console.warn(
      `[plugins:${deps.sessionId}] could not resolve this session's overlay dep dirs for `
      + `\`${req.command}\` — a plugin that loads a dependency out of the project's tree will `
      + `fail to import it:`,
      message(err),
    );
  }
  if (mountErrors.length > 0) {
    return refuse(
      `this session's files could not be mounted into the plugin container: ${mountErrors.join("; ")}.`,
    );
  }

  const env = [
    `${PLUGIN_PROJECT_ENV}=${CONTAINER_PROJECT_DIR}`,
    `${PLUGIN_STATE_ENV}=${CONTAINER_PLUGIN_STATE_DIR}`,
    ...(hasSettings ? [`${PLUGIN_SETTINGS_ENV}=${CONTAINER_PLUGIN_SETTINGS_FILE}`] : []),
    // req 15 — readable by the plugin itself, and UNSET under `repo: self`,
    // which is how a plugin tells a live working tree from an exact commit.
    ...(commit ? [`${PLUGIN_COMMIT_ENV}=${commit}`] : []),
    // The run-time half of the install container's overrides, and for a TRACKED
    // import it has to be the SAME list: a browser or a global binary that
    // `install` fetched lives under `/plugin`, so this container has to resolve
    // the variable naming it to the same path, or the install succeeded into
    // somewhere nothing looks (`plugin-container-env.ts`).
    //
    // Keyed on `pinned`, which is exactly "not `repo: self`". Under `repo: self`
    // `/plugin` is the user's own working tree and the post-turn `git add -A`
    // would commit whatever a lazy download wrote there — and no exported
    // `install` ran to put anything there in the first place, so the image's own
    // values (including the browser baked at `/opt/playwright-browsers`) are
    // both safer and more useful than a ShipIt path that is always empty.
    ...(await pluginContainerEnv(deps.docker, deps.image, { toolchain: pinned !== null })),
    ...declaredCredentialEnv(deps, exported.credentials),
  ];

  try {
    // Fail closed, before anything starts: a plugin container ShipIt cannot
    // deny at its own API is not one to run.
    await ensureUntrustedPluginNetwork(deps.docker, PLUGIN_CLI_NETWORK);
  } catch (err) {
    return refuse(`the plugin network could not be prepared: ${message(err)}`);
  }

  // req 24 — and fail closed for the same reason the network is: a contained
  // session whose plugin container cannot be contained does not get an
  // uncontained one. On an uncontained session this is a no-op that hands back
  // the plugin network itself, which is exactly what this container has always
  // used.
  let netns: PluginNetns;
  try {
    netns = await preparePluginNetns({
      docker: deps.docker,
      sessionId: deps.sessionId,
      network: PLUGIN_CLI_NETWORK,
      // The holder borrows the same toolchain image, for the same reason this
      // container does: it is already here.
      holderImage: deps.image,
      policy: deps.egress?.() ?? UNCONTAINED_PLUGIN_EGRESS,
    });
  } catch (err) {
    return refuse(`this session's network policy could not be applied to the plugin container: ${message(err)}`);
  }

  const entry = path.posix.join(CONTAINER_PLUGIN_DIR, surfaced.entry);
  try {
    return await execute(deps, {
      mounts,
      env,
      entry,
      args: req.args,
      workingDir: mapWorkingDir(deps.workspaceDir, req.cwd),
      stdin: req.stdin ?? "",
      networkMode: netns.networkMode,
      overlaySpec,
    });
  } catch (err) {
    // The daemon refusing to create or start the container is the ordinary
    // failure mode of a plugin whose entrypoint is not executable or has no
    // shebang — a mistake in the plugin, reported as one. Letting it throw
    // would reach the agent as an opaque 500 with the cause only in the
    // orchestrator's log.
    return refuse(`\`${surfaced.name}\` could not be started (${entry}): ${message(err)}`);
  } finally {
    // The holder outlives the workload by construction — the workload is IN its
    // namespace — so this has to run on every path, including the refusal above
    // and a `execute` that threw before creating anything.
    await netns.release();
  }
}

/**
 * One live generation, resolved ONCE: its concrete directory, the commit its
 * record names, and the manifest that directory carries.
 *
 * Everything downstream reads from this rather than from the `active` symlink,
 * which is what keeps the entrypoint, the commit, the volume name and the
 * lowerdir describing one generation — see the call site for the failure the
 * per-fact reads produced.
 */
interface PinnedGeneration {
  dir: string;
  commit: string;
  /**
   * docs/273-plugin-generation-rebuild — which BUILD of that commit this is,
   * taken from the resolved directory's own name. The volume this invocation
   * attaches is named by it, so a rebuild published beside the version an
   * earlier call mounted cannot be reached under the older build's name.
   */
  generationId: string;
  exports: PluginExport[];
  /**
   * Drops the consumer lease this pin holds (req 15). Called by
   * {@link runPluginCommand}'s `finally` and nowhere else — the pin is what the
   * container mounts, so the lease has to outlive every step between here and
   * the container's removal.
   */
  release: ReleaseHold;
}

/**
 * Resolve `active`, read the generation behind it, and hold it. `null` when the
 * repository has no live generation; throws when the link exists but cannot be
 * resolved, and when the generation it resolved is being pruned right now —
 * both of which the caller reports as its own failure.
 *
 * **`expectedSource` is required, and this is the one reader where omitting it
 * would run code rather than render it.** The identity check lives in
 * `readActiveGeneration`/`readActiveManifest`, which follow the symlink
 * themselves; the `…At` readers take a bare directory and deliberately carry no
 * check, because their contract is *the caller already verified this*. This
 * function resolves the link ITSELF and then uses them — so without the
 * comparison below it opts out of the check by construction, not by
 * forgetfulness, and no compiler sweep over the wrappers can find it.
 *
 * What that would cost: the pinned directory is what the invocation container
 * MOUNTS. It feeds the entrypoint, the overlay lowerdir, the volume name and
 * `SHIPIT_PLUGIN_COMMIT`. Between a `repos:` entry being re-pointed and the
 * activation round that retires the foreign generation, `active` still resolves
 * to the PREVIOUS repository's tree — so this path would execute a stranger's
 * entrypoint under the declared name, against `/project` and the plugin's state
 * directory. Every other unguarded reader displays or validates; this one runs.
 *
 * Verifying here rather than inside the `…At` readers keeps "resolve once" and
 * "check identity" composable: one resolution, one record read, one comparison.
 * Pushing the check down into `readGenerationManifestAt` would force it to
 * re-read the record its caller just read, on the path whose whole purpose is
 * to read once.
 */
function pinGeneration(
  sessionId: string,
  stateDir: string,
  repoName: string,
  expectedSource: string,
): PinnedGeneration | null {
  const link = activeLinkPath(stateDir, repoName);
  if (!fs.existsSync(link)) return null;
  const dir = fs.realpathSync(link);
  const record = readGenerationRecordAt(dir);
  // A directory with no readable record is not a generation this may run: the
  // commit is req 15's identity, and inventing one would mis-name the volume.
  if (!record) return null;
  // …and neither is one built from a repository this declaration no longer
  // names. Reading it as absent is the same answer every other reader gives.
  if (record.source !== expectedSource) return null;
  // **The lease is taken here, in the same synchronous block that resolved the
  // link** (req 15, `plugin-leases.ts`). This whole function is synchronous —
  // `realpathSync`, then two `readFileSync`s — so nothing can run between
  // resolving `active` and holding what it resolved to. Taking the hold a tick
  // later would reopen exactly the race it closes: a publish landing in that
  // tick prunes this directory, and the invocation container then mounts an
  // overlay whose lowerdir is gone.
  const generationId = generationIdFor(dir, record);
  const release = holdGeneration({ sessionId, repoName, generationId });
  if (!release) {
    // The pruner has claimed this generation, so it was superseded between the
    // wrapper's call and this line and its tree is being removed right now.
    // Thrown rather than reported as "nothing is active", because something is:
    // the newer generation the refresh just published.
    throw new Error("the version it resolved was replaced mid-call — run the command again");
  }
  return { dir, commit: record.commit, generationId, exports: readGenerationManifestAt(dir), release };
}

/**
 * One mount, in whichever form the runtime actually has.
 *
 * **This is not cosmetic, and a plain bind is wrong in production** (review
 * finding). The orchestrator sees a session under its own `/workspace/...`; in
 * production that whole tree lives inside a named volume the daemon knows
 * nothing about, so handing those paths to Docker as bind sources creates
 * empty, root-owned directories instead of the project — `/project` would not
 * be the project and `/plugin-state` would not be the state a plugin service is
 * writing to, which is reqs 17, 18, 21 and 27 all silently untrue. The
 * established translation is a volume mount with `VolumeOptions.Subpath`
 * (`container-lifecycle.ts`, and `compose-generator.ts` for service
 * containers); {@link volumeSubpathFor} is that translation, shared with the
 * compose surface so the two cannot derive it differently.
 *
 * The subpath is taken relative to `stateRoot` — the orchestrator-visible root
 * of that volume — rather than a hardcoded `/workspace/`, which is the same
 * pair `resolvePluginOverlayRoots` already threads through for the overlay's
 * daemon paths. Both must be present for the volume form: `workspaceVolume`
 * alone cannot say where the volume begins.
 *
 * **With a volume runtime and no usable subpath, this THROWS rather than
 * falling back to a bind.** A bind there is not a degraded mount, it is the
 * defect: the container starts, every path exists, and the plugin reads an empty
 * directory instead of the project. There is nothing to degrade to, so the run
 * is refused and the reason is reported — the same fail-closed choice the
 * compose surface makes by dropping the service with an issue on its card.
 *
 * `install` sidesteps all of this because its ONE mount is a named volume, and
 * a name needs no translation. Every other mount here is a session path.
 */
export interface MountSpec {
  Type: "bind" | "volume";
  Source: string;
  Target: string;
  ReadOnly?: boolean;
  VolumeOptions?: { Subpath?: string };
}

/** Thrown by {@link sessionPathMount}; carried to the caller as a refusal. */
export class PluginMountError extends Error {}

export function sessionPathMount(
  deps: Pick<PluginCliDeps, "workspaceVolume" | "stateRoot">,
  hostPath: string,
  target: string,
  readOnly: boolean,
): MountSpec {
  if (!deps.workspaceVolume) {
    // Dev / dogfood: the session tree is a real path the daemon can see too, so
    // the identity translation is the correct one.
    return { Type: "bind", Source: hostPath, Target: target, ReadOnly: readOnly };
  }
  const subpath = deps.stateRoot ? volumeSubpathFor(deps.stateRoot, hostPath) : null;
  if (subpath === null) {
    throw new PluginMountError(
      `\`${target}\` (${hostPath}) is not inside this deployment's session volume`,
    );
  }
  return {
    Type: "volume",
    Source: deps.workspaceVolume,
    Target: target,
    ReadOnly: readOnly,
    VolumeOptions: { Subpath: subpath },
  };
}

/**
 * Only the names the plugin declared, and only those the consuming project has
 * a value for.
 *
 * A missing one is deliberately omitted rather than sent empty: req 23 wants a
 * missing key to be a visible, named gap (the Plugins tab's needs rows), and an
 * empty-string credential turns that into an authentication error from a
 * third-party API instead.
 *
 * **Nothing outside the consuming project's own `SecretStore` can reach here**
 * (req 23, last sentence). This module does not import `CredentialStore` and
 * could not use one if it did: the dep is typed as `loadSecrets` alone, and the
 * key is the consuming session's remote — never the plugin repository's, which
 * is the trap `plan.md` §3 records for the "Add key…" affordance and which
 * applies identically on the read side.
 */
function declaredCredentialEnv(deps: PluginCliDeps, declared: readonly string[]): string[] {
  if (declared.length === 0 || !deps.consumerRepoUrl || !deps.secretStore) return [];
  // WHICH names count as satisfied is the credential slice's decision, taken
  // once (`loadSatisfiedPluginCredentialNames`: SecretStore only, keyed by the
  // consuming session's remote, non-empty values only). Delivery reads it
  // rather than re-deriving it, so the card cannot say "satisfied" while the
  // container gets nothing, or the reverse.
  const satisfied = loadSatisfiedPluginCredentialNames(deps.secretStore, deps.consumerRepoUrl);
  const wanted = declared.filter((name) => satisfied.has(name));
  if (wanted.length === 0) return [];
  try {
    const stored = deps.secretStore.loadSecrets(deps.consumerRepoUrl);
    return wanted.map((name) => `${name}=${stored[name]}`);
  } catch {
    return [];
  }
}

/**
 * Where the command runs, translated from the wrapper's own cwd.
 *
 * A companion CLI is invoked the way any other command is — from wherever the
 * agent happens to be — so a cwd inside the workspace is carried across as the
 * matching path under `/project`. Anything else (a cwd outside the workspace,
 * a path that no longer exists, one that escapes) falls back to the project
 * root: Docker would otherwise CREATE the working directory, which for a path
 * under `/project` means writing a stray directory into the user's repository.
 */
export function mapWorkingDir(workspaceDir: string, cwd: string | undefined): string {
  if (!cwd) return CONTAINER_PROJECT_DIR;
  const rel = path.posix.relative(CONTAINER_WORKSPACE_DIR, path.posix.normalize(cwd));
  if (!rel) return CONTAINER_PROJECT_DIR;
  if (rel.startsWith("..") || path.posix.isAbsolute(rel)) return CONTAINER_PROJECT_DIR;
  try {
    if (!fs.statSync(path.join(workspaceDir, rel)).isDirectory()) return CONTAINER_PROJECT_DIR;
  } catch {
    return CONTAINER_PROJECT_DIR;
  }
  return path.posix.join(CONTAINER_PROJECT_DIR, rel);
}

interface ExecuteSpec {
  mounts: MountSpec[];
  env: string[];
  entry: string;
  args: string[];
  workingDir: string;
  stdin: string;
  /**
   * The plugin network, or `container:<holder>` when this session's egress is
   * contained (req 24, `plugin-egress.ts`). Never a session container's
   * namespace — that would make the worker's loopback credential broker this
   * container's own (req 19).
   */
  networkMode: string;
  /**
   * The runtime overlay this container was built to mount, when it mounts one.
   * Re-verified after `createContainer` and before `start()` — the same
   * placement as the session dep-dir path (nikzlabs/shipit#2495). Absent for
   * `repo: self`, which binds the working tree instead.
   */
  overlaySpec?: PluginOverlaySpec;
}

/** Create, attach, run, and collect. */
async function execute(deps: PluginCliDeps, spec: ExecuteSpec): Promise<PluginCliResult> {
  // docs/270 — a plugin container writes THIS session's workspace and overlay,
  // so it runs as this session's identity rather than the one global uid. A
  // session that predates per-session identities resolves to that global value,
  // so its plugin containers are unchanged.
  const identity = identityForSession(deps.sessionId);
  const container = await deps.docker.createContainer({
    Image: deps.image,
    Labels: { [PLUGIN_CLI_LABEL]: deps.sessionId },
    // The image's ENTRYPOINT prepares a session's mounts and drops privileges
    // for the worker; none of that applies here, and its chown loop would walk
    // mounts this container does not have.
    Entrypoint: [spec.entry],
    Cmd: spec.args,
    WorkingDir: spec.workingDir,
    Env: spec.env,
    ...(identity !== null ? { User: `${identity.uid}:${identity.gid}` } : {}),
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    HostConfig: {
      // Cast the same way `container-lifecycle.ts` does: dockerode's
      // `MountSettings` demands every `VolumeOptions` field, while the daemon
      // accepts `Subpath` alone.
      Mounts: spec.mounts as unknown as Docker.MountSettings[],
      NetworkMode: spec.networkMode,
      AutoRemove: false, // removed below, after the exit code is read
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Memory: CLI_MEMORY_BYTES,
      PidsLimit: CLI_PIDS_LIMIT,
      Tmpfs: { "/tmp": "rw,exec,nosuid,size=512m" },
    },
  });

  const timeoutMs = deps.timeoutMs ?? DEFAULT_PLUGIN_CLI_TIMEOUT_MS;
  try {
    // nikzlabs/shipit#2495 / planning#451 — the volume was verified at ensure
    // time, and `createContainer` is the first instant Docker's implicit
    // named-volume creation (a missing name becomes a plain empty local volume)
    // is observable. Checked before start() so this `finally` still owns the
    // container removal; the volume itself is shared with plugin services, so
    // it is not removed here. An unattached impostor is repaired on the next
    // `ensurePluginRuntimeOverlay`.
    if (spec.overlaySpec) {
      await assertOverlayVolumesMatch(deps.docker, [spec.overlaySpec], {
        sessionId: deps.sessionId,
      });
    }
    // Attached BEFORE start: output written between start and attach is simply
    // gone, and for a command that only prints one line that is all of it.
    const stream = await container.attach({
      stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
    });
    const out = new Capture();
    const err = new Capture();
    deps.docker.modem.demuxStream(stream, out.sink, err.sink);

    await container.start();
    // `StdinOnce` closes the container's stdin on end, so a command reading to
    // EOF terminates whether or not the caller piped anything.
    stream.end(spec.stdin);

    const code = await waitForContainerExit(container, timeoutMs, deps.isCancelled);
    // `wait` can resolve before the attach stream has delivered its last
    // chunk — the container is gone and the bytes are still in flight — so a
    // command that prints one line and exits could report nothing at all.
    // Bounded, because a stream that never ends must not outlive the container
    // it belonged to.
    await streamSettled(stream as unknown as Duplex);
    if (code === "timeout") {
      return {
        error: `\`${path.posix.basename(spec.entry)}\` did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`,
        exitCode: 124,
        stdout: out.text(),
        stderr: err.text(),
      };
    }
    if (code === "cancelled") {
      return { error: "the session went away while the command was running", exitCode: 125, stdout: out.text(), stderr: err.text() };
    }
    return { exitCode: typeof code === "number" ? code : 1, stdout: out.text(), stderr: err.text() };
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

/** How long the output stream may take to finish after the container exits. */
const STREAM_DRAIN_MS = 5_000;

/**
 * Resolve once the hijacked attach stream is done, or after a short grace.
 *
 * Never rejects: an errored stream means the output is as complete as it is
 * going to get, and the exit code — which came from the daemon, not from
 * here — is still the answer the caller needs.
 */
function streamSettled(stream: Duplex): Promise<void> {
  // Checked first, and not just for speed: an already-finished stream emits
  // neither `end` nor `close` again, so a listener-only implementation would
  // pay the full grace period on the common path — every short command.
  if (stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, STREAM_DRAIN_MS);
    timer.unref?.();
    stream.once("end", done);
    stream.once("close", done);
    stream.once("error", done);
  });
}

/**
 * A bounded sink for one output stream.
 *
 * Buffered output has to have a ceiling: this text crosses two HTTP hops and
 * lands in an agent's context. Truncation is announced in the stream itself
 * rather than silently — output that stops mid-sentence reads as a crashed
 * command.
 */
class Capture {
  readonly sink = new PassThrough();
  private chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  constructor() {
    this.sink.on("data", (chunk: Buffer) => {
      if (this.size >= MAX_STREAM_BYTES) {
        this.truncated = true;
        return;
      }
      const room = MAX_STREAM_BYTES - this.size;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(slice);
      this.size += slice.length;
      if (slice.length < chunk.length) this.truncated = true;
    });
  }

  text(): string {
    const body = Buffer.concat(this.chunks).toString("utf-8");
    return this.truncated ? `${body}\n…[output truncated by ShipIt at 8 MiB]\n` : body;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
