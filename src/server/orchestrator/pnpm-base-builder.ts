import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Docker from "dockerode";

import { waitForContainerExit } from "./plugin-container.js";
import { sessionPathMount, type MountSpec } from "./plugin-cli-run.js";
import { stackLabel, stackLabelFilters } from "./stack-label.js";
import { publishBase, type PublishOutcome, type OverlayScope } from "./overlay-base.js";
import { overlayScopeHash } from "./overlay-volume.js";
import { CONTAINER_WORKSPACE_PATH, PNPM_BASE_DEP_DIR } from "./overlay-session.js";
import { PNPM_STORE_CONTAINER_PATH } from "./container-lifecycle.js";
import {
  decidePnpmBaseEligibility,
  describeIneligible,
  stagePnpmInputs,
  type PnpmIneligible,
  type StagePnpmInputsDeps,
} from "./pnpm-base-inputs.js";
import {
  stageVerifiedRegistry,
  DEFAULT_REGISTRY_URL,
  type FetchLike,
} from "./pnpm-base-registry.js";

/**
 * Builds the verified pnpm `node_modules` base in a dedicated container
 * (docs/276-shared-package-cache-integrity plan.md section 5, "Build — canonical by
 * construction"; reqs 1, 3, 6).
 *
 * The container has **no network**, no workspace and an explicit known configuration. Its
 * private store is populated inside the sandbox from the orchestrator's already-verified
 * tarballs, served by a loopback registry that exists only for the fetch phase; the build
 * itself then runs `--offline` with no registry reachable at all. pnpm generates the tree,
 * every symlink, every `.bin` shim and the state files, so none of that needs a second
 * implementation and none of it carries anything from a session.
 */

export const PNPM_BUILDER_LABEL = "shipit-pnpm-base-build";
export const PNPM_BUILDER_SUBDIR = "pnpm-base-build";

/**
 * This orchestrator PROCESS, on the container and on the work dir it nests every run under. It is
 * what lets the boot reaper tell a previous process's leftovers from a build THIS process has
 * already started: the reaper is launched un-awaited (`startup-monitors.ts`) and does its pnpm
 * sweep after paced plugin cleanup, so a restored session can finish its install and be building by
 * the time it runs. Random rather than the pid, which a restarted orchestrator container reuses.
 */
export const PNPM_BUILDER_RUN_LABEL = "shipit-pnpm-base-build-run";
const BUILDER_RUN_ID = crypto.randomUUID();

/**
 * The builder's project and store paths are the SESSION's own container paths, not paths of
 * the builder's choosing. pnpm records `storeDir` in `node_modules/.modules.yaml` and the
 * publish preserves it, so a base built at any other path is a base the consuming session
 * reads as a store mismatch — it reinstalls, or refuses, instead of hitting the warm tree
 * (FINDINGS.md, "the private store must sit at the same container path the base was built
 * with"). `/build` holds only what the session never sees.
 */
export const BUILD_PROJECT_DIR = CONTAINER_WORKSPACE_PATH;
export const BUILD_STORE_DIR = PNPM_STORE_CONTAINER_PATH;
export const BUILD_ROOT = "/build";
export const BUILD_REGISTRY_DIR = `${BUILD_ROOT}/registry`;
export const BUILD_HOME_DIR = `${BUILD_ROOT}/home`;

/** Loopback only; the container runs with `NetworkMode: none`, so nothing else can reach it. */
export const BUILD_REGISTRY_PORT = 4873;
export const BUILD_REGISTRY_URL = `http://127.0.0.1:${BUILD_REGISTRY_PORT}/`;

/**
 * The pinned pnpm the image bakes. Invoked by PATH rather than through corepack's shim, and
 * with pnpm's own version management off — measured 2026-09-21 that BOTH are needed: a repo
 * whose `package.json` pins `packageManager: pnpm@10.28.2` switches the corepack shim AND
 * makes the pinned binary self-switch, and only `manage-package-manager-versions=false` stops
 * the second half.
 */
export const BUILDER_PNPM_BIN = "/opt/pnpm/bin/pnpm";

export const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60_000;
const BUILD_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const BUILD_PIDS_LIMIT = 512;
const LOG_TAIL_LINES = 60;
const DETAIL_MAX_CHARS = 2000;

export interface PnpmBaseBuilderDeps {
  docker: Docker;
  image: string;
  stateDir: string;
  workspaceVolume?: string;
  stateRoot?: string;
  registryUrl?: string;
  /**
   * `@scope` -> registry, for the scopes the operator authorized. One map decides both halves:
   * whether an `.npmrc` mapping is admitted, and which registry that scope's packages are then
   * verified against. Empty by default, so a scoped registry gets no base until an operator
   * says otherwise.
   */
  authorizedScopeRegistries?: Record<string, string>;
  timeoutMs?: number;
  stackName?: string;
  fetchImpl?: FetchLike;
  gitDeps?: StagePnpmInputsDeps;
  /** Injected for tests; production publishes through `overlay-base.ts`. */
  publish?: typeof publishBase;
}

export interface PnpmBaseBuildRequest {
  /** Bare cache of the repo, which every input is read out of at `commit`. */
  repoDir: string;
  /**
   * The commit the base is built from. It is the default-branch commit by construction —
   * there is no other value to pass, which is what makes `sourceIsDefaultBranch` a fact here
   * rather than the assertion it is on the snapshot-publisher path.
   */
  defaultBranchCommit: string;
  scope: OverlayScope;
  /** Ancestry oracle `publishBase` orders publications with. */
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
  markerStamp?: { runtimeKey: string; installCommands: string[]; depsHash?: string | null };
}

export type PnpmBaseBuildOutcome =
  | { status: "ineligible"; detail: string; reason: PnpmIneligible }
  | { status: "verification-failed"; failedPackage: string; detail: string }
  | { status: "build-failed"; detail: string }
  | { status: "skipped-building"; detail: string }
  | { status: "published"; outcome: PublishOutcome; generation: number | null };

/**
 * A build runs for minutes and every session's install can trigger one, so admission is decided
 * here rather than at a call site: one build per scope, and a ceiling across scopes because each
 * builder container is memory-capped at `BUILD_MEMORY_BYTES` and several at once is what the host
 * feels. Over either bound the trigger SKIPS rather than queues — the next session's install
 * triggers again, so a skipped commit is built shortly after rather than never, while a queue
 * would hold work for a commit that has since moved on.
 *
 * One orchestrator owns every operation on a scope (`overlay-base.ts`, `withScopeLock`), so an
 * in-process set is the whole boundary.
 */
const buildsInFlight = new Set<string>();
export const MAX_CONCURRENT_PNPM_BASE_BUILDS = 2;

/**
 * The loopback registry the fetch phase reads. It is a static file server over the tarballs
 * the orchestrator already verified: it authenticates nothing and does not need to, because a
 * tarball only reaches `tarballs/` after three digests agreed (`pnpm-base-registry.ts`).
 */
export const BUILD_REGISTRY_SERVER = `import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const root = process.argv[2];
const meta = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
const routes = JSON.parse(fs.readFileSync(path.join(root, "tarballs.json"), "utf8"));
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "").split("?")[0]);
  const file = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : null;
  if (file) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    fs.createReadStream(path.join(root, "tarballs", file)).pipe(res);
    return;
  }
  const name = url.slice(1);
  const packument = Object.prototype.hasOwnProperty.call(meta, name) ? meta[name] : null;
  if (!packument) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(packument));
});
server.listen(Number(process.argv[3] || ${BUILD_REGISTRY_PORT}), "127.0.0.1", () => {
  fs.writeFileSync(process.argv[4], "");
});
`;

export interface BuilderScriptPaths {
  pnpmBin: string;
  projectDir: string;
  registryDir: string;
  storeDir: string;
  registryUrl: string;
  /** Outside the registry mount, so the staged tarballs can be mounted read-only. */
  readyFile: string;
}

export function builderScriptPaths(): BuilderScriptPaths {
  return {
    pnpmBin: BUILDER_PNPM_BIN,
    projectDir: BUILD_PROJECT_DIR,
    registryDir: BUILD_REGISTRY_DIR,
    storeDir: BUILD_STORE_DIR,
    registryUrl: BUILD_REGISTRY_URL,
    readyFile: "/tmp/pnpm-base-registry.ready",
  };
}

/**
 * The two phases, in one shell. The fetch phase is the only one that reaches the loopback
 * registry; the build phase is pointed at an unreachable port so an `--offline` regression
 * fails loudly instead of quietly downloading. `node_modules` is discarded between them, so
 * the published tree is produced by the offline install alone.
 */
export function builderScript(paths: BuilderScriptPaths = builderScriptPaths()): string {
  const pnpm = `"${paths.pnpmBin}" --store-dir "${paths.storeDir}"`;
  return [
    "set -e",
    `rm -f "${paths.readyFile}" "${paths.readyFile}.log"`,
    // Its own log file, not the build's pipe: a failed build must not leave the server holding
    // the pipe open, and a server that cannot bind must still be able to say why.
    `node "${paths.registryDir}/server.mjs" "${paths.registryDir}" ${new URL(paths.registryUrl).port} "${paths.readyFile}" >"${paths.readyFile}.log" 2>&1 &`,
    "registry_pid=$!",
    `trap 'kill "$registry_pid" 2>/dev/null || true' EXIT`,
    `i=0; while [ ! -f "${paths.readyFile}" ]; do
  i=$((i+1))
  if [ "$i" -gt 300 ]; then
    echo "loopback registry did not start:" >&2
    cat "${paths.readyFile}.log" >&2 || true
    exit 1
  fi
  if ! kill -0 "$registry_pid" 2>/dev/null; then
    echo "loopback registry exited before it was ready:" >&2
    cat "${paths.readyFile}.log" >&2 || true
    exit 1
  fi
  sleep 0.1
done`,
    `cd "${paths.projectDir}"`,
    // `--ignore-pnpmfile` on BOTH phases. A hook is not a script, so `--ignore-scripts` does
    // not stop it (measured, FINDINGS.md), and a hook that runs in either phase can rewrite
    // the inputs — or the binary — the other phase then uses to produce the published tree.
    `${pnpm} fetch --ignore-scripts --ignore-pnpmfile --registry ${paths.registryUrl}`,
    "kill $registry_pid 2>/dev/null || true",
    // The published tree must come from the offline install alone, not from what the fetch
    // phase laid down while the loopback registry was still up.
    "rm -rf node_modules",
    `${pnpm} install --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile --registry http://127.0.0.1:1/`,
    `test -d "${paths.projectDir}/node_modules"`,
  ].join("\n");
}

/**
 * The container's whole configuration, stated rather than inherited: no user `.npmrc`, no
 * global `.npmrc`, no credentials, a HOME inside the sandbox, and pnpm's `packageManager`
 * version switching off. `--store-dir` and `--registry` are passed on the command line, which
 * outranks any `.npmrc` the staged snapshot carries.
 */
export function builderEnv(homeDir: string = BUILD_HOME_DIR): string[] {
  return [
    `HOME=${homeDir}`,
    `XDG_CACHE_HOME=${homeDir}/cache`,
    `XDG_CONFIG_HOME=${homeDir}/config`,
    `XDG_DATA_HOME=${homeDir}/data`,
    `XDG_STATE_HOME=${homeDir}/state`,
    "npm_config_userconfig=/dev/null",
    "npm_config_globalconfig=/dev/null",
    // Three separate switches, because a repo's `packageManager` field reaches the builder by
    // three routes (all measured 2026-09-21): corepack's shim honours it, an explicitly
    // versioned corepack invocation does not, and the pinned binary invoked directly
    // self-switches unless pnpm's own version management is off.
    "PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=false",
    "COREPACK_ENABLE_PROJECT_SPEC=0",
    "COREPACK_ENABLE_AUTO_PIN=0",
    "npm_config_update_notifier=false",
    "CI=1",
  ];
}

export function pnpmBuildRootDir(stateDir: string, scopeHash: string): string {
  return path.join(stateDir, PNPM_BUILDER_SUBDIR, BUILDER_RUN_ID, scopeHash);
}

export async function buildVerifiedPnpmBase(
  deps: PnpmBaseBuilderDeps,
  req: PnpmBaseBuildRequest,
): Promise<PnpmBaseBuildOutcome> {
  const scopeHash = overlayScopeHash(
    req.scope.repoUrl,
    req.scope.runtimeKey,
    req.scope.depDir,
    req.scope.namespace,
  );
  // Claimed synchronously, before the first await: a check that yields first lets a rival trigger
  // through the same gap it was meant to close.
  if (buildsInFlight.has(scopeHash)) {
    return { status: "skipped-building", detail: "a build of this base is already running" };
  }
  if (buildsInFlight.size >= MAX_CONCURRENT_PNPM_BASE_BUILDS) {
    return {
      status: "skipped-building",
      detail: `${buildsInFlight.size} base builds are already running`,
    };
  }
  buildsInFlight.add(scopeHash);

  // The `finally` opens HERE, not after the staging below: an ENOSPC or a permission error while
  // creating those directories would otherwise hold the scope's slot for the orchestrator's whole
  // life, and two such failures would hold the global one.
  let root: string | null = null;
  try {
    // One directory per invocation, not per scope: two builds of the same scope must not clear
    // each other's inputs mid-run, whatever serialization the caller does or does not hold.
    const scopeDir = pnpmBuildRootDir(deps.stateDir, scopeHash);
    fs.mkdirSync(scopeDir, { recursive: true });
    root = fs.mkdtempSync(path.join(scopeDir, "run-"));
    const projectDir = path.join(root, "project");
    const registryDir = path.join(root, "registry");
    const storeDir = path.join(root, "store");
    const homeDir = path.join(root, "home");

    for (const dir of [projectDir, registryDir, storeDir, homeDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const staged = await stagePnpmInputs({
      repoDir: req.repoDir,
      commit: req.defaultBranchCommit,
      destDir: projectDir,
      ...(deps.gitDeps ? { deps: deps.gitDeps } : {}),
    });
    if ("eligible" in staged) {
      return { status: "ineligible", detail: describeIneligible(staged), reason: staged };
    }

    const registryUrl = deps.registryUrl ?? DEFAULT_REGISTRY_URL;
    const decision = decidePnpmBaseEligibility(staged, {
      registryUrl,
      ...(deps.authorizedScopeRegistries
        ? { authorizedScopeRegistries: deps.authorizedScopeRegistries }
        : {}),
    });
    if (!decision.eligible) {
      return { status: "ineligible", detail: describeIneligible(decision), reason: decision };
    }

    const stagedRegistry = await stageVerifiedRegistry({
      packages: decision.packages,
      destDir: registryDir,
      registryUrl,
      builderRegistryUrl: BUILD_REGISTRY_URL,
      ...(deps.authorizedScopeRegistries
        ? { authorizedScopeRegistries: deps.authorizedScopeRegistries }
        : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    if (!stagedRegistry.ok) {
      // The same one decision, taken where the verified package content is readable: a package
      // with an install-time build gets no base rather than an unverified one (planning#604).
      if ("ineligible" in stagedRegistry) {
        const reason = stagedRegistry.ineligible;
        return { status: "ineligible", detail: describeIneligible(reason), reason };
      }
      return {
        status: "verification-failed",
        failedPackage: stagedRegistry.failedPackage,
        detail: stagedRegistry.detail,
      };
    }
    fs.writeFileSync(path.join(registryDir, "server.mjs"), BUILD_REGISTRY_SERVER);

    const run = await runBuilderContainer(deps, {
      projectDir,
      registryDir,
      storeDir,
      homeDir,
      commit: req.defaultBranchCommit,
    });
    if (run.failure) return { status: "build-failed", detail: run.failure };

    const snapshotDir = path.join(projectDir, PNPM_BASE_DEP_DIR);
    if (!fs.existsSync(snapshotDir) || fs.readdirSync(snapshotDir).length === 0) {
      return { status: "build-failed", detail: "the build produced no node_modules" };
    }

    const publish = deps.publish ?? publishBase;
    const result = await publish({
      stateDir: deps.stateDir,
      scope: req.scope,
      candidate: {
        commit: req.defaultBranchCommit,
        exitCode: 0,
        // Both are true BY CONSTRUCTION here: the tree was built by the orchestrator from
        // committed inputs, before any session touched it. Unlike the snapshot publisher,
        // which asserts the same two about a tree it merely pulled.
        preUserInstall: true,
        sourceIsDefaultBranch: true,
        snapshotDir,
        ...(req.markerStamp ? { markerStamp: req.markerStamp } : {}),
      },
      isAncestor: req.isAncestor,
      currentDefaultCommit: req.defaultBranchCommit,
    });
    return {
      status: "published",
      outcome: result.outcome,
      generation: result.pointer?.generation ?? null,
    };
  } finally {
    buildsInFlight.delete(scopeHash);
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Boot only: these belong to a previous orchestrator process — of THIS stack. The builder's
 * timeout and its `finally` both live in the orchestrator, so a crash between creating the
 * container and finishing the build strands both the container and its work dir with nothing
 * left to reclaim them.
 */
export async function reapOrphanPnpmBaseBuilds(
  docker: Docker,
  stateDir: string,
  opts: { stackName?: string } = {},
): Promise<number> {
  let removed = 0;
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [PNPM_BUILDER_LABEL, ...stackLabelFilters(opts.stackName)] },
    });
    for (const { Id, Labels } of containers) {
      // Never this process's own: the reaper is not awaited before builds are admitted.
      if (Labels?.[PNPM_BUILDER_RUN_LABEL] === BUILDER_RUN_ID) continue;
      try {
        await docker.getContainer(Id).remove({ force: true });
        removed++;
      } catch {
        /* Best-effort orphan cleanup. */
      }
    }
  } catch (err) {
    console.warn("[pnpm-base] could not list builder containers:", message(err));
  }

  // Remove the work dirs after the containers, which still hold their mounts. Every run nests under
  // its process's id, so this process's in-flight staging is never one of them.
  const root = path.join(stateDir, PNPM_BUILDER_SUBDIR);
  try {
    for (const entry of fs.readdirSync(root)) {
      if (entry === BUILDER_RUN_ID) continue;
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[pnpm-base] could not clear stranded builder work dirs:", message(err));
    }
  }
  if (removed > 0) console.log(`[pnpm-base] removed ${removed} orphan builder container(s)`);
  return removed;
}

async function runBuilderContainer(
  deps: PnpmBaseBuilderDeps,
  dirs: { projectDir: string; registryDir: string; storeDir: string; homeDir: string; commit: string },
): Promise<{ failure: string | null }> {
  let mounts: MountSpec[];
  try {
    mounts = [
      sessionPathMount(deps, dirs.projectDir, BUILD_PROJECT_DIR, false),
      // Read-only: the verified tarballs are the one input nothing in the container may edit.
      sessionPathMount(deps, dirs.registryDir, BUILD_REGISTRY_DIR, true),
      sessionPathMount(deps, dirs.storeDir, BUILD_STORE_DIR, false),
      sessionPathMount(deps, dirs.homeDir, BUILD_HOME_DIR, false),
    ];
  } catch (err) {
    return { failure: `the builder's inputs could not be mounted: ${message(err)}` };
  }

  const container = await deps.docker.createContainer({
    Image: deps.image,
    Labels: {
      [PNPM_BUILDER_LABEL]: dirs.commit,
      [PNPM_BUILDER_RUN_LABEL]: BUILDER_RUN_ID,
      ...stackLabel(deps.stackName),
    },
    Entrypoint: ["/bin/sh", "-c"],
    Cmd: [builderScript()],
    WorkingDir: BUILD_PROJECT_DIR,
    // Docker merges the image's ENV, so every setting the build depends on is named here.
    Env: builderEnv(),
    HostConfig: {
      Mounts: mounts as unknown as Docker.MountSettings[],
      // No `User`: nothing from the repo executes here — scripts and hooks are both off and
      // no hook source is even staged — so the container runs only pnpm, over inputs the
      // orchestrator verified, with no capabilities, no privilege escalation and no network.
      NetworkMode: "none",
      AutoRemove: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Memory: BUILD_MEMORY_BYTES,
      PidsLimit: BUILD_PIDS_LIMIT,
      Tmpfs: { "/tmp": "rw,exec,nosuid,size=512m" },
    },
  });

  const timeoutMs = deps.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  try {
    await container.start();
    const code = await waitForContainerExit(container, timeoutMs);
    const output = await logTail(container);
    if (code === "timeout") {
      return { failure: `the build did not finish within ${Math.round(timeoutMs / 1000)}s` };
    }
    if (code !== 0) {
      return { failure: `the build exited ${String(code)}${output ? `:\n${output}` : ""}` };
    }
    return { failure: null };
  } finally {
    await container.remove({ force: true }).catch((err: unknown) => {
      console.warn(
        `[pnpm-base] could not remove the builder container ${container.id}:`,
        message(err),
      );
    });
  }
}

async function logTail(container: Docker.Container): Promise<string> {
  try {
    const raw = await container.logs({ stdout: true, stderr: true, tail: LOG_TAIL_LINES });
    const text = Buffer.isBuffer(raw) ? demultiplex(raw) : String(raw);
    return clip(text.trim());
  } catch {
    return "";
  }
}

function clip(text: string): string {
  return text.length > DETAIL_MAX_CHARS ? `…${text.slice(-DETAIL_MAX_CHARS)}` : text;
}

// Non-TTY Docker logs use 8-byte stream headers. Pass unframed buffers through.
function demultiplex(raw: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const stream = raw[offset];
    if (stream > 2 || raw[offset + 1] !== 0 || raw[offset + 2] !== 0 || raw[offset + 3] !== 0) {
      return raw.toString("utf-8");
    }
    const size = raw.readUInt32BE(offset + 4);
    if (offset + 8 + size > raw.length) return raw.toString("utf-8");
    parts.push(raw.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  if (offset !== raw.length) return raw.toString("utf-8");
  return Buffer.concat(parts).toString("utf-8");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
