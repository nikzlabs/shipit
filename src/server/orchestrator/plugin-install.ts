import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type Docker from "dockerode";
import { CONTAINER_PLUGIN_DIR, PLUGIN_COMMIT_ENV } from "../shared/plugin-contract.js";
import type { PluginExport } from "../shared/plugin-repos.js";
import type { PluginInstallJob, PluginInstallResult } from "./plugin-generations.js";
import { pluginsRoot } from "./plugin-generations.js";
import {
  adoptPluginDepBases,
  describePluginDepStoreReason,
  planPluginDepStore,
  pluginBasePinDir,
  pluginDepCacheDir,
  promotePluginDepDirs,
  type PluginDepStoreDecision,
  type PluginDepStoreReason,
} from "./plugin-dep-store.js";
import {
  buildPluginOverlaySpec,
  createPluginOverlay,
  pluginWorkDir,
  removePluginOverlay,
  resolvePluginOverlayRoots,
  PLUGIN_OVERLAY_LABEL,
} from "./plugin-overlay.js";
import {
  chownToSessionWorker,
  handPluginCheckoutToWorker,
  identityForSession,
  shareTreeOnce,
} from "./session-worker-uid.js";
import { ensureUntrustedPluginNetwork, waitForContainerExit } from "./plugin-container.js";
import {
  preparePluginNetns,
  unreachableDeclaredHosts,
  UNCONTAINED_PLUGIN_EGRESS,
  PLUGIN_NETNS_LABEL,
  type PluginEgressPolicy,
  type PluginNetns,
} from "./plugin-egress.js";
import { PLUGIN_CLI_LABEL, sessionPathMount, type MountSpec } from "./plugin-cli-run.js";
import { pluginContainerEnv, PLUGIN_TOOLCHAIN_DIRS } from "./plugin-container-env.js";
import { DEP_CACHE_CONTAINER_PATH } from "../shared/fs-constants.js";
import { readInstallRecord, writeInstallRecord, type PluginInstallOutcome } from "./plugin-install-record.js";

export const PLUGIN_INSTALL_DIR = CONTAINER_PLUGIN_DIR;
// Register this subnet as untrusted before containers can reach the orchestrator API.
export const PLUGIN_INSTALL_NETWORK = "shipit-plugin-install";
export const PLUGIN_INSTALL_LABEL = "shipit-plugin-install";
export const DEFAULT_PLUGIN_INSTALL_TIMEOUT_MS = 10 * 60_000;

const INSTALL_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const INSTALL_PIDS_LIMIT = 512;
const LOG_TAIL_LINES = 40;
const REASON_MAX_CHARS = 2000;

export interface PluginInstallDeps {
  docker: Docker;
  image: string;
  sessionId: string;
  stateDir: string;
  depStoreDir?: string;
  workspaceVolume?: string;
  stateRoot?: string;
  timeoutMs?: number;
  egress?: () => PluginEgressPolicy;
}

interface InstallCommand {
  plugin: string;
  command: string;
}

export function installCommands(exportsList: readonly PluginExport[]): InstallCommand[] {
  return exportsList
    .filter((e): e is PluginExport & { install: string } => Boolean(e.install?.trim()))
    .map((e) => ({ plugin: e.name, command: e.install.trim() }));
}

export function installStamp(job: PluginInstallJob): string {
  return JSON.stringify({ commit: job.commit, commands: installCommands(job.exports) });
}

export function installStampPath(stateDir: string, repoName: string, generationId: string): string {
  return path.join(pluginWorkDir(stateDir, repoName, generationId), "install-stamp.json");
}

export function createPluginInstallRunner(
  deps: PluginInstallDeps,
): (job: PluginInstallJob) => Promise<PluginInstallResult> {
  return async (job) => {
    const record = (
      outcome: PluginInstallOutcome,
      detail?: string,
      output?: string,
      depStoreReason?: string,
    ): void =>
      writeInstallRecord(pluginsRoot(deps.stateDir), job.repoName, {
        commit: job.commit,
        generationId: job.generationId,
        at: new Date().toISOString(),
        outcome,
        ...(detail ? { detail } : {}),
        ...(output ? { output } : {}),
        ...(depStoreReason ? { depStoreReason } : {}),
      });

    const commands = installCommands(job.exports);
    if (commands.length === 0) return { ok: true };

    // Thrown cleanup or promotion failures must also leave an install record.
    try {
      return await runInstallOnce(deps, job, commands, record);
    } catch (err) {
      record("failed", `the install did not complete: ${message(err)}`);
      throw err;
    }
  };
}

async function runInstallOnce(
  deps: PluginInstallDeps,
  job: PluginInstallJob,
  commands: readonly InstallCommand[],
  record: (
    outcome: PluginInstallOutcome,
    detail?: string,
    output?: string,
    depStoreReason?: string,
  ) => void,
): Promise<PluginInstallResult> {

    const stampPath = installStampPath(deps.stateDir, job.repoName, job.generationId);
    const stamp = installStamp(job);
    const layerDirs = {
      upperdir: path.join(pluginWorkDir(deps.stateDir, job.repoName, job.generationId), "upper"),
      workdir: path.join(pluginWorkDir(deps.stateDir, job.repoName, job.generationId), "work"),
    };

    // Prefer the build's stamped layer: it may contain output outside shared dep dirs.
    // Force must bypass both the stamp and store so the install actually runs again.
    const recorded = job.force ? null : readStamp(stampPath);
    if (recorded?.stamp === stamp && pinsResolve(deps.depStoreDir, recorded.basePins)) {
      console.log(`[plugins] ${job.repoName}: install already done for ${job.commit.slice(0, 9)}`);
      // Preserve output from the reused build; a store hit must not inherit this output.
      const previous = readInstallRecord(pluginsRoot(deps.stateDir), job.repoName);
      const carried = previous?.commit === job.commit ? previous.output : undefined;
      record(
        "skipped-stamp",
        "this version's writable layer was already installed for these inputs",
        carried,
        previous?.commit === job.commit ? previous.depStoreReason : undefined,
      );
      return { ok: true, ...(recorded.basePins.length > 0 ? { basePins: recorded.basePins } : {}) };
    }

    const decision: PluginDepStoreDecision = deps.depStoreDir
      ? planPluginDepStore({ source: job.source, exports: job.exports, checkoutDir: job.stagingDir })
      : { plan: null, reason: { kind: "no-store" } };
    const plan = decision.plan;
    if (plan && deps.depStoreDir && !job.force) {
      const pins = adoptPluginDepBases(deps.depStoreDir, plan);
      if (pins) {
        // Discard failed-attempt leftovers above the adopted base.
        await prepareLayer(layerDirs, stampPath);
        await writeStamp(stampPath, stamp, pins);
        console.log(
          `[plugins] ${job.repoName}: ${job.commit.slice(0, 9)} reuses shared dependencies — install skipped`,
        );
        record(
          "skipped-store",
          "these dependency inputs were already in the shared store, so no install command ran; "
          + "anything the install would ALSO have built is not in that store",
        );
        return { ok: true, basePins: pins };
      }
    }

    let spec;
    try {
      await ensureUntrustedPluginNetwork(deps.docker, PLUGIN_INSTALL_NETWORK);
      const roots = await resolvePluginOverlayRoots(deps.docker, deps.workspaceVolume, deps.stateRoot);
      spec = buildPluginOverlaySpec({
        sessionId: deps.sessionId,
        repoName: job.repoName,
        generationId: job.generationId,
        stateDir: deps.stateDir,
        checkoutDir: job.stagingDir,
        ...roots,
      });
      await prepareLayer(spec.orchDirs, stampPath);
      // Overlay permissions come from the lower directory. Hand over the worktree
      // without changing ownership of hardlinked objects in the shared bare cache.
      handPluginCheckoutToWorker(job.stagingDir);
      await createPluginOverlay(deps.docker, spec);
    } catch (err) {
      const reason = `could not prepare the plugin's writable layer: ${message(err)}`;
      record("failed", reason);
      return { ok: false, reason };
    }

    // Namespace setup and failure reporting must use the same policy snapshot.
    const policy = deps.egress?.() ?? UNCONTAINED_PLUGIN_EGRESS;
    let outcome: { ok: boolean; reason?: string };
    let netns: PluginNetns | null = null;
    const outputs: string[] = [];
    try {
      netns = await preparePluginNetns({
        docker: deps.docker,
        sessionId: deps.sessionId,
        network: PLUGIN_INSTALL_NETWORK,
        holderImage: deps.image,
        policy,
      });
      outcome = { ok: true };
      for (const { plugin, command } of commands) {
        if (job.isCancelled?.()) {
          outcome = { ok: false, reason: "the session went away during install" };
          break;
        }
        const run = await runInstallContainer(
          deps, job, spec.volumeName, command, netns.networkMode,
        );
        if (run.output) outputs.push(commands.length > 1 ? `--- ${plugin}\n${run.output}` : run.output);
        if (run.failure) {
          outcome = {
            ok: false,
            reason: `install for \`${plugin}\` ${run.failure}${blockedHostsClause(policy, job)}`,
          };
          break;
        }
      }
    } catch (err) {
      outcome = { ok: false, reason: `install could not run: ${message(err)}` };
    } finally {
      await netns?.release();
    }

    const installOutput = clip(outputs.join("\n\n"));

    // Runtime uses a different lowerdir over this upperdir; the install mount must go first.
    const released = await removePluginOverlay(deps.docker, spec.volumeName);
    if (!released) {
      const reason = `the plugin's writable layer could not be released (volume ${spec.volumeName} is still held)`;
      record("failed", reason, installOutput);
      return { ok: false, reason };
    }
    if (!outcome.ok) {
      record("failed", outcome.reason, installOutput);
      return outcome;
    }

    if (!plan || !deps.depStoreDir) {
      await writeStamp(stampPath, stamp, []);
      record("succeeded", undefined, installOutput, noteDepStoreMiss(job.repoName, decision.reason));
      return { ok: true };
    }

    // Promotion moves directories out of upperdir, so it must follow unmount.
    const promoted = await promotePluginDepDirs({
      depStoreDir: deps.depStoreDir,
      plan,
      commit: job.commit,
      upperDir: spec.orchDirs.upperdir,
      repoName: job.repoName,
    });
    const basePins = promoted.map((p) => p.pin).filter((pin): pin is string => pin !== null);

    // A pointer-write failure after rename can leave output in neither usable location.
    const lost = promoted.filter((p) => p.lost).map((p) => p.depDir);
    if (lost.length > 0) {
      const reason = `the installed \`${lost.join("`, `")}\` could not be stored — install ran but its output was lost`;
      record("failed", reason, installOutput);
      return { ok: false, reason };
    }

    await writeStamp(stampPath, stamp, basePins);
    const unshared = promoted
      .filter((p) => p.pin === null && p.reason !== undefined)
      .map((p) => p.reason!);
    record("succeeded", undefined, installOutput, noteDepStoreMiss(job.repoName, ...unshared));
    return { ok: true, ...(basePins.length > 0 ? { basePins } : {}) };
}

function noteDepStoreMiss(
  repoName: string,
  ...reasons: (PluginDepStoreReason | undefined)[]
): string | undefined {
  const joined = reasons
    .filter((r): r is PluginDepStoreReason => r !== undefined)
    .map(describePluginDepStoreReason)
    .join(" ");
  const text = joined.length > REASON_MAX_CHARS ? `${joined.slice(0, REASON_MAX_CHARS)}…` : joined;
  if (!text) return undefined;
  console.log(`[plugins] ${repoName}: ${text}`);
  return text;
}

// Denied hosts are separate information, not proof of why an install failed.
function blockedHostsClause(policy: PluginEgressPolicy, job: PluginInstallJob): string {
  const declared = job.exports.flatMap((e) =>
    (e.hosts ?? []).filter((h) => !h.optional).map((h) => h.name),
  );
  const blocked = unreachableDeclaredHosts(policy, declared);
  if (blocked.length === 0) return "";
  const names = blocked.map((h) => `\`${h}\``).join(", ");
  const [is, it] = blocked.length === 1 ? ["is", "it"] : ["are", "them"];
  return `\n\nSeparately — this plugin declares ${names}, which ${is} not in this `
    + "session's egress allowlist. If the failure above is a network error against "
    + `${blocked.length === 1 ? "that host" : "one of those hosts"}, allow ${it} on this `
    + "repository's card in the Plugins tab, then refresh the plugin.";
}

async function prepareLayer(
  orchDirs: { upperdir: string; workdir: string },
  stampPath: string,
): Promise<void> {
  // Invalidate the stamp before clearing output so a crash cannot leave a false cache hit.
  await fsp.rm(stampPath, { force: true });
  await fsp.rm(orchDirs.upperdir, { recursive: true, force: true });
  await fsp.rm(orchDirs.workdir, { recursive: true, force: true });
  await fsp.mkdir(orchDirs.upperdir, { recursive: true });
  await fsp.mkdir(orchDirs.workdir, { recursive: true });
  chownToSessionWorker(path.dirname(orchDirs.upperdir));
  chownToSessionWorker(orchDirs.upperdir);
  chownToSessionWorker(orchDirs.workdir);
}

function readStamp(stampPath: string): { stamp: string; basePins: string[] } | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stampPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { stamp, basePins } = parsed as Record<string, unknown>;
    if (typeof stamp !== "string") return null;
    if (basePins !== undefined && (!Array.isArray(basePins) || basePins.some((p) => typeof p !== "string"))) {
      return null;
    }
    return { stamp, basePins: (basePins as string[] | undefined) ?? [] };
  } catch {
    return null;
  }
}

async function writeStamp(stampPath: string, stamp: string, basePins: string[]): Promise<void> {
  await fsp.writeFile(stampPath, JSON.stringify({ stamp, basePins })).catch(() => undefined);
}

function pinsResolve(depStoreDir: string | undefined, pins: readonly string[]): boolean {
  if (pins.length === 0) return true;
  if (!depStoreDir) return false;
  return pins.every((pin) => {
    const dir = pluginBasePinDir(depStoreDir, pin);
    return dir !== null && fs.existsSync(dir);
  });
}

async function runInstallContainer(
  deps: PluginInstallDeps,
  job: PluginInstallJob,
  volumeName: string,
  command: string,
  networkMode: string,
): Promise<{ failure: string | null; output: string }> {
  const identity = identityForSession(deps.sessionId);
  const depCache = resolveDepCacheMount(deps, job);
  const container = await deps.docker.createContainer({
    Image: deps.image,
    Labels: { [PLUGIN_INSTALL_LABEL]: deps.sessionId },
    Entrypoint: ["/bin/sh", "-c"],
    // Shared caches and promoted trees need group writes across session UIDs.
    Cmd: [`umask 002; mkdir -p ${PLUGIN_TOOLCHAIN_DIRS.join(" ")}; ${command}`],
    WorkingDir: PLUGIN_INSTALL_DIR,
    ...(identity !== null ? { User: `${identity.uid}:${identity.gid}` } : {}),
    // Docker merges image ENV; pluginContainerEnv replaces its unwritable tool paths.
    Env: [
      `${PLUGIN_COMMIT_ENV}=${job.commit}`,
      ...(await pluginContainerEnv(deps.docker, deps.image, { toolchain: true })),
      ...(depCache
        ? [
          `npm_config_cache=${DEP_CACHE_CONTAINER_PATH}/npm`,
          `YARN_CACHE_FOLDER=${DEP_CACHE_CONTAINER_PATH}/yarn`,
          `PNPM_STORE_DIR=${DEP_CACHE_CONTAINER_PATH}/pnpm`,
        ]
        : []),
    ],
    HostConfig: {
      Binds: [`${volumeName}:${PLUGIN_INSTALL_DIR}`],
      ...(depCache ? { Mounts: [depCache] as unknown as Docker.MountSettings[] } : {}),
      NetworkMode: networkMode,
      AutoRemove: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Memory: INSTALL_MEMORY_BYTES,
      PidsLimit: INSTALL_PIDS_LIMIT,
      Tmpfs: { "/tmp": "rw,exec,nosuid,size=512m" },
    },
  });

  const timeoutMs = deps.timeoutMs ?? DEFAULT_PLUGIN_INSTALL_TIMEOUT_MS;
  try {
    await container.start();
    const code = await waitForContainerExit(container, timeoutMs, job.isCancelled);
    // Capture all outcomes before removing the stopped container.
    const output = await logTail(container);
    if (code === "timeout") {
      return { failure: `did not finish within ${Math.round(timeoutMs / 1000)}s`, output };
    }
    if (code === "cancelled") {
      return { failure: "was stopped because the session went away", output };
    }
    if (code !== 0) return { failure: `exited ${code}${output ? `:\n${output}` : ""}`, output };
    return { failure: null, output };
  } finally {
    await container.remove({ force: true }).catch((err: unknown) => {
      console.warn(
        `[plugins] ${job.repoName}: could not remove the install container ${container.id} — `
        + "it is stranded until the next orchestrator restart:",
        message(err),
      );
    });
  }
}

function resolveDepCacheMount(deps: PluginInstallDeps, job: PluginInstallJob): MountSpec | null {
  if (!deps.depStoreDir) return null;
  try {
    const dir = pluginDepCacheDir(deps.depStoreDir, job.source);
    fs.mkdirSync(dir, { recursive: true });
    // This source-scoped cache is shared by containers with different session UIDs.
    shareTreeOnce(dir);
    return sessionPathMount(deps, dir, DEP_CACHE_CONTAINER_PATH, false);
  } catch (err) {
    console.warn(
      `[plugins] ${job.repoName}: no shared download cache for this install:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function logTail(container: Docker.Container): Promise<string> {
  try {
    const raw = await container.logs({ stdout: true, stderr: true, tail: LOG_TAIL_LINES });
    return clip(demultiplex(raw).trim());
  } catch {
    return "";
  }
}

function clip(text: string): string {
  return text.length > REASON_MAX_CHARS ? `…${text.slice(-REASON_MAX_CHARS)}` : text;
}

// Boot only: these workloads belong to the previous process. Remove containers
// before volumes; live-session prefixes would otherwise exempt volumes from the janitor.
export async function reapOrphanPluginInstalls(
  docker: Docker,
  opts: { paceMs?: number } = {},
): Promise<number> {
  let removed = 0;
  const pace = async (): Promise<void> => {
    if (opts.paceMs) await sleep(opts.paceMs);
  };

  for (const label of [PLUGIN_INSTALL_LABEL, PLUGIN_CLI_LABEL, PLUGIN_NETNS_LABEL]) {
    try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [label] },
    });
    for (const { Id } of containers) {
      try {
        await docker.getContainer(Id).remove({ force: true });
        removed++;
      } catch {
        // Best-effort orphan cleanup.
      }
      await pace();
    }
  } catch (err) {
    console.warn(`[plugins] could not list ${label} containers:`, message(err));
    }
  }

  try {
    const volumes = await docker.listVolumes({ filters: { label: [PLUGIN_OVERLAY_LABEL] } });
    for (const { Name } of volumes.Volumes ?? []) {
      if (await removePluginOverlay(docker, Name)) removed++;
      await pace();
    }
  } catch (err) {
    console.warn("[plugins] could not list generation volumes:", message(err));
  }

  if (removed > 0) console.log(`[plugins] removed ${removed} orphan install artifact(s)`);
  return removed;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
