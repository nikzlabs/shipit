// docs/331-persist-own-volume: each session's /persist is a Docker volume of its own.
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type Docker from "dockerode";
import type { SessionIdentity } from "../shared/session-identity.js";
import { COMPOSE_HELPER_LABEL } from "./compose-helper.js";
import {
  COMPOSE_PROJECT_LABEL,
  PARENT_SESSION_LABEL,
  composeProjectName,
  downComposeStackByProject,
} from "./compose-stack-reaper.js";
import { withPersistLease } from "./persist-gate.js";
import { demultiplex, waitForContainerExit } from "./plugin-container.js";
import { CONTAINER_SESSION_ID_LABEL } from "./session-container.js";
import { SESSION_SCRATCH_SUBDIR } from "./session-state-dir.js";
import { identityForTarget, sessionWorkerGid } from "./session-worker-uid.js";
import { isShipItOwnSession } from "./shipit-own-sessions.js";
import { stackLabel, stackLabelFilters } from "./stack-label.js";

export const PERSIST_LAYOUT_FILE = "persist-layout";
export const PERSIST_HELPER_LABEL = "shipit-persist-helper";
export const BOOT_LABEL = "shipit-boot";
/** Chosen at process start: a persist helper with another value belongs to an earlier process. */
export const BOOT_ID = randomUUID();
/** No name of this form may be made through the Docker proxy (`docker-proxy.ts`). */
export const PERSIST_VOLUME_NAME_PREFIX = "shipit-persist.";

const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const WORKSPACE_VOLUME_ROOT = "/workspace";

// A copy waits for a running `up`, build included; past this it is tried at the next start.
const COPY_GATE_WAIT_MS = 2 * 60_000;
export const RETENTION_GATE_WAIT_MS = 60_000;
const RESET_GATE_WAIT_MS = 2 * 60_000;
export const ORPHAN_PERSIST_VOLUME_GRACE_MS = 24 * 60 * 60 * 1000;

const HELPER_MEMORY_BYTES = 256 * 1024 * 1024;
const HELPER_PIDS_LIMIT = 64;

/**
 * Starts with `shipit-p`, so the boot sweep's `^shipit-([a-f0-9-]{12})_` never matches it, whatever
 * the workspace volume is called; the workspace volume keeps two installs on one daemon apart.
 */
export function persistVolumePrefix(workspaceVolume: string): string {
  return `${PERSIST_VOLUME_NAME_PREFIX}${workspaceVolume}.`;
}

export function persistVolumeName(workspaceVolume: string, sessionId: string): string {
  return `${persistVolumePrefix(workspaceVolume)}${sessionId}`;
}

// Each selects a volume for some removal path, and `shipit-parent-session` also lets that session
// mount it through the Docker proxy (plan, "The volume").
const FOREIGN_VOLUME_LABELS = [
  "shipit-session",
  PARENT_SESSION_LABEL,
  COMPOSE_PROJECT_LABEL,
  "shipit-plugin-generation",
] as const;

export function persistVolumeLabels(stackName: string | undefined): Record<string, string> {
  return { "shipit-managed": "true", ...stackLabel(stackName) };
}

/** Why ShipIt must not use an existing volume of this name, or null. A restored one has no labels. */
export function unsafePersistVolume(info: { Driver?: string; Options?: Record<string, string> | null; Labels?: Record<string, string> | null }): string | null {
  if (info.Driver !== "local") return `its driver is ${info.Driver ?? "unknown"}`;
  if (info.Options && Object.keys(info.Options).length > 0) return "it has driver options";
  const label = FOREIGN_VOLUME_LABELS.find((l) => info.Labels?.[l] !== undefined);
  return label ? `it carries the label ${label}` : null;
}

export type PersistLayout = "volume" | "scratch";

/**
 * `scratch/` stays authoritative until the record says `volume`, and only the copy writes the
 * record over an existing `scratch/`. A new session gets the record here. A record that cannot be
 * read throws: guessing `scratch` would hide the volume's files.
 */
export function persistLayout(sessionDir: string): PersistLayout {
  if (hasLayoutRecord(sessionDir)) return "volume";
  if (pathExists(path.join(sessionDir, SESSION_SCRATCH_SUBDIR))) return "scratch";
  try {
    writeLayoutRecord(sessionDir);
  } catch (err) {
    console.warn(`[persist] could not record the volume layout in ${sessionDir}; /persist stays a directory:`, message(err));
    return "scratch";
  }
  return "volume";
}

function hasLayoutRecord(sessionDir: string): boolean {
  try {
    return fs.readFileSync(path.join(sessionDir, PERSIST_LAYOUT_FILE), "utf8").trim() === "volume";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * The commit point of the copy. Throws only before the rename: once the record is there it is
 * authoritative, so a failed flush of the directory is logged and the layout is still `volume`.
 */
export function writeLayoutRecord(sessionDir: string): void {
  const file = path.join(sessionDir, PERSIST_LAYOUT_FILE);
  const tmp = `${file}.${randomBytes(4).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, "volume\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  try {
    const dir = fs.openSync(sessionDir, "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch (err) {
    console.warn(`[persist] could not flush ${sessionDir} after recording the volume layout:`, message(err));
  }
}

export type PersistScript = "prepare" | "copy" | "measure" | "empty";

interface ScriptSpec {
  text: string;
  caps: readonly string[];
  timeoutMs: number;
}

// Arguments reach a script as "$@", never in its text.
export const PERSIST_SCRIPTS: Readonly<Record<PersistScript, ScriptSpec>> = {
  // Root hands the volume root to the session; each subdirectory is made as the session user, so a
  // planted symlink reaches only this container's own read-only filesystem.
  prepare: {
    text: [
      "owner=$1; shift",
      'if [ -n "$owner" ]; then',
      '  { chown "$owner" /persist && chmod g+rwxs /persist && setfacl -d -m g::rwx /persist; } \\',
      '    || echo "could not hand /persist to the session user" >&2',
      "fi",
      'for sub in "$@"; do',
      '  if [ -n "$owner" ]; then',
      '    gosu "$owner" mkdir -p -- "/persist/$sub" || exit 1',
      "    gosu \"$owner\" sh -c 'chmod g+rwxs -- \"$1\" && setfacl -d -m g::rwx -- \"$1\"' sh \"/persist/$sub\" \\",
      '      || echo "could not give the session group write access to /persist/$sub" >&2',
      "  else",
      '    mkdir -p -- "/persist/$sub" || exit 1',
      "  fi",
      "done",
    ].join("\n"),
    // FSETID: without it Linux clears the setgid bit root sets on a directory of another group.
    caps: ["CHOWN", "FOWNER", "FSETID", "SETUID", "SETGID"],
    timeoutMs: 5 * 60_000,
  },
  // The wipe makes a repeat safe; `cp -a` keeps owners, modes, ACLs and symlinks and follows none.
  copy: {
    text: [
      "set -e",
      "find /new -mindepth 1 -delete",
      "cp -a /old/. /new/",
      "chown --reference=/old /new",
      "chmod --reference=/old /new",
      "sync -f /new",
      "du -sk /new",
    ].join("\n"),
    caps: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"],
    timeoutMs: 30 * 60_000,
  },
  // The rule of `treeBytes` (data-retention-sweep.ts): every entry that is not a directory,
  // symlinks included, max(1, blocks × 512 || size). Summed here, so the output is one line.
  measure: {
    text: [
      "{ find /persist -mindepth 1 ! -type d -printf '%b %s\\n'; echo \"end $?\"; } | awk '",
      '  $1 == "end" { status = $2; next }',
      "  { n = $1 * 512; if (n == 0) n = $2; if (n < 1) n = 1; total += n }",
      '  END { if (status != "0") exit 1; printf "%.0f\\n", total }\'',
    ].join("\n"),
    caps: ["DAC_READ_SEARCH"],
    timeoutMs: 10 * 60_000,
  },
  empty: {
    text: "find /persist -mindepth 1 -delete",
    caps: ["DAC_OVERRIDE", "FOWNER"],
    timeoutMs: 10 * 60_000,
  },
};

export interface PersistHelperMount {
  Type: "volume";
  Source: string;
  Target: string;
  ReadOnly?: boolean;
  VolumeOptions?: { NoCopy?: boolean; Subpath?: string };
}

export interface PersistHelperResult {
  code: number;
  interrupted?: "timeout";
  stdout: string;
  stderr: string;
}

/** A session's /persist as a Compose start sees it. */
export interface SessionPersist {
  /** The session's own volume, or null while the session is on the scratch layout. */
  volume: () => Promise<string | null>;
  /** Make the volume root and each subdirectory exist and belong to the session (docs/317 req 5). */
  prepare: (volume: string, subpaths: readonly string[]) => Promise<void>;
}

export interface AgentPersist {
  /** The session's volume after the copy, or null on the scratch layout. The creation resolves the mount again under its lease. */
  volume: string | null;
  /** Compose services the copy removed; the caller starts them again after the copy. */
  restart: string[];
}

export interface PersistVolumesDeps {
  docker: Docker;
  workspaceVolume: string;
  /** The session worker image: GNU coreutils and findutils, awk, setfacl and gosu. */
  image: string;
  stackName?: string;
  /** Where the orchestrator mounts the workspace volume. */
  workspaceRoot?: string;
}

export class PersistVolumes {
  // Sessions whose helpers of earlier processes are gone; none can appear later.
  private readonly checkedSessions = new Set<string>();
  // Helpers of this process whose forced removal failed: they can still be writing.
  private readonly unremoved = new Map<string, Set<string>>();
  // One stale-helper check at a time per session, so two starts do not remove one helper twice.
  private readonly staleChecks = new Map<string, Promise<void>>();

  constructor(private readonly deps: PersistVolumesDeps) {}

  volumeName(sessionId: string): string {
    return persistVolumeName(this.deps.workspaceVolume, sessionId);
  }

  /** The session id a volume of this install belongs to, or null for any other volume. */
  sessionIdOf(volumeName: string): string | null {
    const prefix = persistVolumePrefix(this.deps.workspaceVolume);
    if (!volumeName.startsWith(prefix)) return null;
    const id = volumeName.slice(prefix.length);
    return id && !id.includes(".") ? id : null;
  }

  /**
   * Idempotent; every mount site gets the name from here, so the volume exists before a mount.
   * Docker keeps the labels of an existing volume, so one that someone else made is refused.
   */
  async ensureVolume(sessionId: string): Promise<string> {
    const name = this.volumeName(sessionId);
    await this.deps.docker.createVolume({ Name: name, Driver: "local", Labels: persistVolumeLabels(this.deps.stackName) });
    const unsafe = unsafePersistVolume(await this.deps.docker.getVolume(name).inspect());
    if (unsafe) throw new Error(`ShipIt will not use the volume ${name} for /persist: ${unsafe}.`);
    return name;
  }

  forSession(sessionId: string, sessionDir: string): SessionPersist {
    return {
      volume: async () => {
        if (persistLayout(sessionDir) === "scratch") return null;
        await this.removeStaleHelpers(sessionId);
        return this.ensureVolume(sessionId);
      },
      prepare: (volume, subpaths) => this.prepare(
        sessionId,
        volume,
        sessionWorkerGid() !== null ? identityForTarget(sessionDir) : null,
        subpaths,
      ),
    };
  }

  async prepare(
    sessionId: string,
    volume: string,
    owner: SessionIdentity | null,
    subpaths: readonly string[],
  ): Promise<void> {
    const subs = [...new Set(subpaths)].filter((sub) => sub !== "");
    const result = await this.runHelper(
      sessionId,
      "prepare",
      [{ Type: "volume", Source: volume, Target: "/persist", VolumeOptions: { NoCopy: true } }],
      [owner ? `${owner.uid}:${owner.gid}` : "", ...subs],
    );
    if (result.code !== 0) {
      throw new Error(`Could not create ${describeSubpaths(subs)} for a compose service: ${failureText(result)}`);
    }
    if (result.stderr.trim()) console.warn(`[persist:${sessionId}] ${result.stderr.trim()}`);
  }

  /**
   * Agent container creation, the one place that copies (req 5). Runs before the caller takes the
   * shared lease for the creation (rule 1). A failed copy leaves the session on the scratch layout,
   * and the next start tries again.
   */
  async forAgent(sessionId: string, sessionDir: string): Promise<AgentPersist> {
    if (persistLayout(sessionDir) === "scratch") {
      try {
        const copied = await this.copy(sessionId, sessionDir);
        return { volume: copied.done ? this.volumeName(sessionId) : null, restart: copied.restart };
      } catch (err) {
        console.warn(`[persist:${sessionId}] /persist was not copied into its volume; it stays a directory for this start:`, message(err));
        return { volume: null, restart: [] };
      }
    }
    await removeScratch(sessionId, sessionDir);
    return { volume: this.volumeName(sessionId), restart: [] };
  }

  /**
   * Before a mount outside an exclusive section, where helpers of this process can run under the
   * shared side. A helper of an earlier process, or one this process could not remove, can still be
   * deleting (a retention `empty` when ShipIt stopped), so it goes, or the mount is refused.
   */
  private removeStaleHelpers(sessionId: string): Promise<void> {
    const previous = this.staleChecks.get(sessionId);
    const check = (async () => {
      await previous?.catch(() => undefined);
      await this.removeStaleHelpersNow(sessionId);
    })();
    this.staleChecks.set(sessionId, check);
    void check.catch(() => undefined).finally(() => {
      if (this.staleChecks.get(sessionId) === check) this.staleChecks.delete(sessionId);
    });
    return check;
  }

  private async removeStaleHelpersNow(sessionId: string): Promise<void> {
    if (!this.checkedSessions.has(sessionId)) {
      for (const helper of await this.ownContainers(PERSIST_HELPER_LABEL, sessionId)) {
        if (helper.Labels?.[BOOT_LABEL] !== BOOT_ID) await this.removeStaleHelper(sessionId, helper.Id);
      }
      this.checkedSessions.add(sessionId);
    }
    // Until none is left: a run of this process can fail to remove its helper meanwhile.
    for (let ids = this.unremoved.get(sessionId); ids && ids.size > 0; ids = this.unremoved.get(sessionId)) {
      for (const id of [...ids]) {
        await this.removeStaleHelper(sessionId, id);
        ids.delete(id);
      }
      if (ids.size === 0 && this.unremoved.get(sessionId) === ids) this.unremoved.delete(sessionId);
    }
  }

  private async removeStaleHelper(sessionId: string, id: string): Promise<void> {
    try {
      await this.deps.docker.getContainer(id).remove({ force: true });
    } catch (err) {
      if (statusCode(err) === 404) return;
      throw new Error(
        `A /persist helper (${id.slice(0, 12)}) of ${sessionId} that can still write could not be removed: ${message(err)}`,
        { cause: err },
      );
    }
  }

  private async copy(sessionId: string, sessionDir: string): Promise<{ done: boolean; restart: string[] }> {
    return withPersistLease(sessionId, "exclusive", async () => {
      // Another start may have copied while this one waited.
      if (persistLayout(sessionDir) === "volume") return { done: true, restart: [] };
      const stack = await this.stackContainers(sessionId);
      const restart = runningServiceNames(stack);
      try {
        // Directly, not through the stack queue: a Compose start holds that queue while it waits
        // for this lease (rule 3).
        if (stack.length > 0) {
          await downComposeStackByProject(this.deps.docker, sessionId, stackLabelFilters(this.deps.stackName));
        }
        return { done: await this.copyLeased(sessionId, sessionDir), restart };
      } catch (err) {
        // The removed services start again whatever went wrong after their removal.
        console.warn(`[persist:${sessionId}] /persist was not copied into its volume:`, message(err));
        return { done: false, restart };
      }
    }, { timeoutMs: COPY_GATE_WAIT_MS });
  }

  private async copyLeased(sessionId: string, sessionDir: string): Promise<boolean> {
    const blocker = await this.blockingContainer(sessionId);
    if (blocker) {
      console.log(`[persist:${sessionId}] /persist stays a directory for this start: ${blocker} can still use it`);
      return false;
    }
    const scratch = path.join(sessionDir, SESSION_SCRATCH_SUBDIR);
    const scratchSubpath = workspaceVolumeSubpath(this.deps.workspaceRoot ?? WORKSPACE_VOLUME_ROOT, scratch);
    if (scratchSubpath === null) throw new Error(`${scratch} is not inside the workspace volume`);
    const volume = await this.ensureVolume(sessionId);
    const started = Date.now();
    const result = await this.runHelper(sessionId, "copy", [
      { Type: "volume", Source: this.deps.workspaceVolume, Target: "/old", ReadOnly: true, VolumeOptions: { Subpath: scratchSubpath } },
      { Type: "volume", Source: volume, Target: "/new", VolumeOptions: { NoCopy: true } },
    ], []);
    if (result.code !== 0) {
      console.warn(`[persist:${sessionId}] copying /persist into ${volume} failed: ${failureText(result)}`);
      await this.runHelper(sessionId, "empty", [
        { Type: "volume", Source: volume, Target: "/persist", VolumeOptions: { NoCopy: true } },
      ], []).catch(() => undefined);
      return false;
    }
    writeLayoutRecord(sessionDir);
    const kib = Number.parseInt(result.stdout.trim(), 10);
    console.log(
      `[persist:${sessionId}] copied /persist into ${volume} `
      + `(${Number.isFinite(kib) ? `${kib} KiB` : "size unknown"}) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    await removeScratch(sessionId, sessionDir);
    return true;
  }

  // Only this install's: another install restored from a backup can have the same session ids.
  private ownContainers(label: string, sessionId: string): Promise<Docker.ContainerInfo[]> {
    return this.deps.docker.listContainers({
      all: true,
      filters: { label: [`${label}=${sessionId}`, ...stackLabelFilters(this.deps.stackName)] },
    });
  }

  private stackContainers(sessionId: string): Promise<Docker.ContainerInfo[]> {
    return this.ownContainers(COMPOSE_PROJECT_LABEL, composeProjectName(sessionId));
  }

  /**
   * Call under the exclusive lease, before its own helpers run. A persist helper of this session
   * that still exists then has outlived its lease, or its process, and can still be writing, so it
   * is removed. Names a container that can still use /persist, or null; that check sees every
   * install's containers, because it removes nothing.
   */
  async blockingContainer(sessionId: string): Promise<string | null> {
    const docker = this.deps.docker;
    await this.removeHelpers(sessionId);
    for (const label of [CONTAINER_SESSION_ID_LABEL, PARENT_SESSION_LABEL, COMPOSE_HELPER_LABEL, PERSIST_HELPER_LABEL]) {
      const found = await docker.listContainers({ all: true, filters: { label: [`${label}=${sessionId}`] } });
      if (found.length > 0) return `container ${found[0].Id.slice(0, 12)} (${label})`;
    }
    return null;
  }

  private async removeHelpers(sessionId: string): Promise<void> {
    let removedAll = true;
    for (const helper of await this.ownContainers(PERSIST_HELPER_LABEL, sessionId)) {
      try {
        await this.deps.docker.getContainer(helper.Id).remove({ force: true });
      } catch (err) {
        if (statusCode(err) !== 404) {
          removedAll = false;
          console.warn(`[persist:${sessionId}] could not remove the persist helper ${helper.Id.slice(0, 12)}:`, message(err));
        }
      }
    }
    if (!removedAll) return;
    this.unremoved.delete(sessionId);
    this.checkedSessions.add(sessionId);
  }

  /** 0 for a session whose volume does not exist yet. */
  async measure(sessionId: string): Promise<number> {
    const volume = this.volumeName(sessionId);
    if (!(await this.usableVolumeExists(volume))) return 0;
    const result = await this.runHelper(sessionId, "measure", [
      { Type: "volume", Source: volume, Target: "/persist", ReadOnly: true, VolumeOptions: { NoCopy: true } },
    ], []);
    // An empty output is a log that could not be read, not a size of 0.
    const out = result.stdout.trim();
    const bytes = Number(out);
    if (result.code !== 0 || !/^\d+$/.test(out) || !Number.isSafeInteger(bytes)) {
      throw new Error(`Measuring /persist of ${sessionId} failed: ${failureText(result)}`);
    }
    return bytes;
  }

  /** Call under the exclusive lease. The volume stays, as `scratch/` stays (docs/323 req 8). */
  async empty(sessionId: string): Promise<void> {
    const volume = this.volumeName(sessionId);
    if (!(await this.usableVolumeExists(volume))) return;
    const result = await this.runHelper(sessionId, "empty", [
      { Type: "volume", Source: volume, Target: "/persist", VolumeOptions: { NoCopy: true } },
    ], []);
    if (result.code !== 0) throw new Error(`Emptying /persist of ${sessionId} failed: ${failureText(result)}`);
  }

  /** Every persist volume of this install, found by name: a volume Docker made implicitly has no labels. */
  async list(): Promise<{ name: string; sessionId: string; createdAt?: string }[]> {
    const prefix = persistVolumePrefix(this.deps.workspaceVolume);
    const out = await this.deps.docker.listVolumes({ filters: { name: [prefix] } });
    const volumes: { name: string; sessionId: string; createdAt?: string }[] = [];
    for (const v of out?.Volumes ?? []) {
      const sessionId = this.sessionIdOf(v.Name);
      if (!sessionId) continue;
      const createdAt = (v as { CreatedAt?: string }).CreatedAt;
      volumes.push({ name: v.Name, sessionId, ...(createdAt ? { createdAt } : {}) });
    }
    return volumes;
  }

  /**
   * Full reset, after every service manager stopped: each session's containers go by label, then
   * its volume. A failure is logged; the orphan sweep tries again.
   */
  async removeAllForReset(): Promise<void> {
    for (const { name, sessionId } of await this.list()) {
      if (isShipItOwnSession(sessionId)) continue;
      try {
        await withPersistLease(sessionId, "exclusive", async () => {
          await this.removeSessionContainers(sessionId);
          const blocker = await this.blockingContainer(sessionId);
          if (blocker) throw new Error(`${blocker} is still there`);
          await this.deps.docker.getVolume(name).remove();
        }, { timeoutMs: RESET_GATE_WAIT_MS });
      } catch (err) {
        console.warn(`[persist] Full reset could not remove ${name}; the orphan sweep tries again:`, message(err));
      }
    }
  }

  private async removeSessionContainers(sessionId: string): Promise<void> {
    const docker = this.deps.docker;
    for (const label of [CONTAINER_SESSION_ID_LABEL, PARENT_SESSION_LABEL, COMPOSE_HELPER_LABEL, PERSIST_HELPER_LABEL]) {
      for (const c of await this.ownContainers(label, sessionId)) {
        try {
          await docker.getContainer(c.Id).remove({ force: true });
        } catch (err) {
          if (statusCode(err) !== 404) throw err;
        }
      }
    }
  }

  /**
   * A volume whose session has no row leaks: a discarded spawned child, a warm session deleted
   * with its repository, a failed Full reset. A persist helper left by a crash would keep it in
   * use, so it goes first; a volume still in use fails to go, and the next pass retries.
   */
  async sweepOrphans(
    sessionIds: ReadonlySet<string>,
    opts: { now?: number; paceMs?: number } = {},
  ): Promise<number> {
    const cutoffMs = (opts.now ?? Date.now()) - ORPHAN_PERSIST_VOLUME_GRACE_MS;
    let removed = 0;
    for (const { name, sessionId, createdAt } of await this.list()) {
      if (sessionIds.has(sessionId) || isShipItOwnSession(sessionId)) continue;
      const created = createdAt ? Date.parse(createdAt) : Number.NaN;
      if (!Number.isFinite(created) || created >= cutoffMs) continue;
      if (opts.paceMs) await new Promise((resolve) => setTimeout(resolve, opts.paceMs));
      try {
        await this.removeHelpers(sessionId);
        await this.deps.docker.getVolume(name).remove();
        removed += 1;
        console.log(`[disk-janitor] removed orphan /persist volume ${name}`);
      } catch (err) {
        console.warn(`[disk-janitor] could not remove orphan /persist volume ${name}:`, message(err));
      }
    }
    return removed;
  }

  // Like `ensureVolume`, refuses a volume of this name that ShipIt did not make.
  private async usableVolumeExists(name: string): Promise<boolean> {
    let info: Parameters<typeof unsafePersistVolume>[0];
    try {
      info = await this.deps.docker.getVolume(name).inspect();
    } catch (err) {
      if (statusCode(err) === 404) return false;
      throw err;
    }
    const unsafe = unsafePersistVolume(info);
    if (unsafe) throw new Error(`ShipIt will not use the volume ${name} for /persist: ${unsafe}.`);
    return true;
  }

  /** One short-lived container per script, under the session's shared lease (rule 2: it borrows an exclusive one). */
  async runHelper(
    sessionId: string,
    script: PersistScript,
    mounts: PersistHelperMount[],
    args: string[],
  ): Promise<PersistHelperResult> {
    return withPersistLease(sessionId, "shared", async () => {
      const spec = PERSIST_SCRIPTS[script];
      const container = await this.deps.docker.createContainer({
        Image: this.deps.image,
        Entrypoint: ["/bin/sh", "-c"],
        Cmd: [spec.text, "sh", ...args],
        User: "0:0",
        WorkingDir: "/",
        Labels: { [PERSIST_HELPER_LABEL]: sessionId, [BOOT_LABEL]: BOOT_ID, ...stackLabel(this.deps.stackName) },
        HostConfig: {
          Mounts: mounts as Docker.MountSettings[],
          NetworkMode: "none",
          CapDrop: ["ALL"],
          CapAdd: [...spec.caps],
          ReadonlyRootfs: true,
          Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16m" },
          SecurityOpt: ["no-new-privileges"],
          Memory: HELPER_MEMORY_BYTES,
          PidsLimit: HELPER_PIDS_LIMIT,
          AutoRemove: false,
        },
      });
      try {
        await container.start();
        const code = await waitForContainerExit(container, spec.timeoutMs);
        const [stdout, stderr] = await Promise.all([
          readLog(container, { stdout: true, stderr: false }),
          readLog(container, { stdout: false, stderr: true, tail: 20 }),
        ]);
        return typeof code === "number"
          ? { code, stdout, stderr }
          : { code: -1, interrupted: "timeout", stdout, stderr };
      } finally {
        await container.remove({ force: true }).catch((err: unknown) => {
          // The next mount removes it or is refused (`removeStaleHelpers`, `blockingContainer`).
          const ids = this.unremoved.get(sessionId) ?? new Set<string>();
          ids.add(container.id);
          this.unremoved.set(sessionId, ids);
          console.warn(`[persist:${sessionId}] could not remove the ${script} helper ${container.id.slice(0, 12)}:`, message(err));
        });
      }
    });
  }
}

/**
 * After the copy removed a running stack: the session's manager starts each service again, now
 * with the volume. A session with no manager yet starts its services with the manager's own start.
 */
export function restartKeptServices(
  mgr: { getService(name: string): unknown; restartService(name: string): Promise<void> } | undefined,
  sessionId: string,
  services: readonly string[],
): void {
  if (!mgr) return;
  for (const name of services) {
    if (!mgr.getService(name)) continue;
    void mgr.restartService(name).catch((err: unknown) => {
      console.warn(`[persist:${sessionId}] could not start ${name} again after the /persist copy:`, message(err));
    });
  }
}

function runningServiceNames(containers: Docker.ContainerInfo[]): string[] {
  const names = containers
    .filter((c) => c.State === "running")
    .map((c) => c.Labels?.[COMPOSE_SERVICE_LABEL])
    .filter((name): name is string => typeof name === "string" && name !== "");
  return [...new Set(names)];
}

/** The workspace volume subpath of an orchestrator path, or null outside it. */
function workspaceVolumeSubpath(root: string, p: string): string | null {
  const rel = path.posix.relative(root, p);
  return rel === "" || rel.startsWith("..") || path.posix.isAbsolute(rel) ? null : rel;
}

// Nothing mounts `scratch/` once the record says `volume`.
async function removeScratch(sessionId: string, sessionDir: string): Promise<void> {
  const scratch = path.join(sessionDir, SESSION_SCRATCH_SUBDIR);
  try {
    await fsp.rm(scratch, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[persist:${sessionId}] could not remove ${scratch}; the next start tries again:`, message(err));
  }
}

async function readLog(
  container: Docker.Container,
  opts: { stdout: boolean; stderr: boolean; tail?: number },
): Promise<string> {
  try {
    const raw = await container.logs({ ...opts, follow: false });
    return Buffer.isBuffer(raw) ? demultiplex(raw) : String(raw);
  } catch {
    return "";
  }
}

function describeSubpaths(subs: readonly string[]): string {
  return subs.length === 0 ? "/persist" : subs.map((sub) => `/persist/${sub}`).join(", ");
}

function failureText(result: PersistHelperResult): string {
  const why = result.interrupted === "timeout" ? "it did not finish in time" : `exit ${result.code}`;
  const stderr = result.stderr.trim();
  return stderr ? `${why}: ${stderr}` : why;
}

function statusCode(err: unknown): number {
  return err && typeof err === "object" && "statusCode" in err ? Number(err.statusCode) : 0;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
