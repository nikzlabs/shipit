// docs/323-archived-session-data-retention
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { SessionInfo } from "../shared/types.js";
import type { PersistedMessage } from "./chat-history.js";
import type { SessionManager } from "./sessions.js";
import { doneSessionTest } from "../shared/session-resolution.js";
import {
  dataDeletionTimeMs,
  isUnderDataRetention,
  retainedDataSizeIsStale,
  retentionPeriodDays,
  type DataRetentionConfig,
} from "../shared/session-retention.js";
import { SESSION_SCRATCH_SUBDIR, SESSION_WORKSPACE_SUBDIR } from "./session-state-dir.js";
import {
  REGENERABLE_SESSION_SUBDIRS,
  reclaimRegenerableSessionDirs,
  getMessage,
  sleep,
} from "./disk-utils.js";
import { persistNoticeUnattached } from "./chat-card-persistence.js";

const SESSION_UPLOADS_SUBDIR = "uploads";

export interface DataRetentionSweepDeps {
  sessionManager: Pick<
    SessionManager,
    "listAll" | "setRetainedData" | "appendPendingAgentNotice" | "dataRetention"
  >;
  chatHistory: { append(sessionId: string, message: PersistedMessage): unknown };
  /** A session directory is `<sessionsRoot>/<id>`; a workspace anywhere else is never touched. */
  sessionsRoot: string;
  /** A runner, a container, a Compose stack or a restore can have the directories in use. */
  isSessionLive: (sessionId: string) => boolean;
  /** Stops a stack that an earlier orchestrator process started; it is in no map of this one. */
  stopComposeStack?: (sessionId: string) => Promise<unknown>;
  onSessionsChanged?: () => void;
  now?: () => number;
  paceMs?: number;
}

export interface DataRetentionSweepResult {
  measured: number;
  sessionsDeleted: number;
  bytesDeleted: number;
}

interface RetainedDirs {
  persist: string;
  uploads: string;
  /** Empty unless the checkout is under retention too (req 10). */
  checkout: string[];
}

interface RetainedSizes {
  persist: number;
  uploads: number;
  checkout: number;
}

export function retainedDataDirs(session: SessionInfo, sessionsRoot: string): RetainedDirs | null {
  const workspaceDir = session.workspaceDir;
  // In any other layout the siblings of the workspace are not this session's own dirs.
  const root = path.join(path.resolve(sessionsRoot), session.id);
  if (!workspaceDir || path.resolve(workspaceDir) !== path.join(root, SESSION_WORKSPACE_SUBDIR)) return null;
  const checkoutUnderRetention = session.userArchived === true
    && session.kind === "sandbox"
    && !session.remoteUrl;
  return {
    persist: path.join(root, SESSION_SCRATCH_SUBDIR),
    uploads: path.join(root, SESSION_UPLOADS_SUBDIR),
    checkout: checkoutUnderRetention
      ? REGENERABLE_SESSION_SUBDIRS.map((sub) => path.join(root, sub))
      : [],
  };
}

// A symlink in place of the directory would send the walk, and the deletion, somewhere else.
async function isRealDir(dir: string): Promise<boolean> {
  try {
    return (await fs.lstat(dir)).isDirectory();
  } catch {
    return false;
  }
}

// Counts files, not directories, so a tree of empty directories has no size.
async function treeBytes(dir: string): Promise<number> {
  if (!(await isRealDir(dir))) return 0;
  let total = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      try {
        const st = await fs.lstat(full);
        // An empty file is still a file to delete, so it counts.
        total += Math.max(1, st.blocks > 0 ? st.blocks * 512 : st.size);
      } catch {
        // The file went away during the walk.
      }
    }
  }
  return total;
}

async function measure(dirs: RetainedDirs): Promise<RetainedSizes> {
  let checkout = 0;
  for (const dir of dirs.checkout) checkout += await treeBytes(dir);
  return {
    persist: await treeBytes(dirs.persist),
    uploads: await treeBytes(dirs.uploads),
    checkout,
  };
}

const totalBytes = (sizes: RetainedSizes): number => sizes.persist + sizes.uploads + sizes.checkout;

async function entryNames(dir: string): Promise<string[]> {
  if (!(await isRealDir(dir))) return [];
  return fs.readdir(dir);
}

// The directory itself stays: mounts and upload listings expect it, with its owner.
async function removeEntries(dir: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    try {
      await fs.rm(path.join(dir, name), { recursive: true, force: true });
    } catch (err) {
      return getMessage(err);
    }
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

interface DeletionFacts {
  /** What this pass deleted; a part that failed is 0 here. */
  sizes: RetainedSizes;
  /** The size that selected the period. */
  measuredBytes: number;
  deletedAt: string;
  archived: boolean;
  config: DataRetentionConfig;
}

function periodReason(facts: DeletionFacts): string {
  const bytes = facts.measuredBytes;
  const days = retentionPeriodDays(bytes, facts.config);
  const large = facts.config.largeDays > 0 && bytes >= facts.config.largeBytes;
  const state = facts.archived ? "was archived" : "was finished and not used";
  const scope = large ? ` for a session with ${formatBytes(facts.config.largeBytes)} or more of these files` : "";
  return `The session ${state} for ${days} days, which is the retention period${scope}.`;
}

function formatDataRetentionNotice(facts: DeletionFacts): string {
  const { sizes } = facts;
  const parts = [
    ...(sizes.persist > 0 ? ["`/persist` files"] : []),
    ...(sizes.uploads > 0 ? ["uploads"] : []),
    ...(sizes.checkout > 0 ? ["checkout"] : []),
  ];
  const effects = [
    ...(sizes.persist > 0 ? ["Files that the agent or a service wrote to `/persist` no longer exist."] : []),
    ...(sizes.uploads > 0 ? ["Files attached to earlier messages no longer load."] : []),
    ...(sizes.checkout > 0
      ? ["This session had no remote, so the files of its workspace are gone, and the workspace is now empty."]
      : []),
  ];
  return (
    `🗑️ ShipIt deleted this session's ${joinList(parts)} on ${facts.deletedAt.slice(0, 10)} `
    + `(${formatBytes(totalBytes(sizes))}). ${periodReason(facts)}\n\n`
    + `${effects.join(" ")} The conversation is not affected.`
  );
}

function formatDataRetentionAgentNotice(facts: DeletionFacts): string {
  const { sizes } = facts;
  const parts = [
    ...(sizes.persist > 0 ? ["the files under /persist"] : []),
    ...(sizes.uploads > 0 ? ["the files under /uploads"] : []),
    ...(sizes.checkout > 0 ? ["the /workspace checkout, which is now an empty directory"] : []),
  ];
  return (
    `[System] On ${facts.deletedAt.slice(0, 10)} ShipIt deleted ${joinList(parts)} of this session, `
    + "because its data retention period ended. Paths there that earlier turns used no longer "
    + "exist. The user has a notice about this in the transcript. Do not try to read those "
    + "files; tell the user when the task needs one of them."
  );
}

async function deleteDueSession(
  id: string,
  deps: DataRetentionSweepDeps,
  now: () => number,
  result: DataRetentionSweepResult,
): Promise<void> {
  const config = deps.sessionManager.dataRetention;
  const iso = (): string => new Date(now()).toISOString();
  // Each await below is a point where the user can restore or open the session, so the
  // decision is taken again from the list as it is then.
  const stillDue = (): { session: SessionInfo; dirs: RetainedDirs } | null => {
    const sessions = deps.sessionManager.listAll();
    const session = sessions.find((s) => s.id === id);
    if (!session) return null;
    const dueAt = dataDeletionTimeMs(session, doneSessionTest(sessions)(session), config);
    if (dueAt === undefined || dueAt > now()) return null;
    if (deps.isSessionLive(id)) return null;
    const dirs = retainedDataDirs(session, deps.sessionsRoot);
    return dirs ? { session, dirs } : null;
  };

  if (!stillDue()) return;
  // A throw here leaves the files: a stack that cannot be stopped can still use them.
  await deps.stopComposeStack?.(id);
  const before = stillDue();
  if (!before) return;

  const { dirs } = before;
  const sizes = await measure(dirs);
  const names = { persist: await entryNames(dirs.persist), uploads: await entryNames(dirs.uploads) };
  // The period comes from what is on disk now, not from an earlier measurement.
  deps.sessionManager.setRetainedData(id, totalBytes(sizes), iso());
  const due = stillDue();
  if (!due) return;

  const deleted: RetainedSizes = { persist: 0, uploads: 0, checkout: 0 };
  const failures: string[] = [];
  for (const part of ["persist", "uploads"] as const) {
    const message = await removeEntries(dirs[part], names[part]);
    if (message) failures.push(`${dirs[part]}: ${message}`);
    else deleted[part] = sizes[part];
  }
  if (dirs.checkout.length > 0 && due.session.workspaceDir) {
    const { failed } = await reclaimRegenerableSessionDirs(due.session.workspaceDir, { paceMs: deps.paceMs });
    if (failed.length > 0) failures.push(...failed.map((f) => `${f.dir}: ${f.message}`));
    else deleted.checkout = sizes.checkout;
  }

  if (totalBytes(deleted) > 0) {
    result.sessionsDeleted += 1;
    result.bytesDeleted += totalBytes(deleted);
    const facts: DeletionFacts = {
      sizes: deleted,
      measuredBytes: totalBytes(sizes),
      deletedAt: iso(),
      archived: due.session.userArchived === true,
      config,
    };
    console.log(
      `[data-retention] ${id}: deleted ${formatBytes(totalBytes(deleted))} `
      + `(persist=${deleted.persist} uploads=${deleted.uploads} checkout=${deleted.checkout})`,
    );
    // Separate, and before the size is stored: one failed write must not lose the other.
    try {
      persistNoticeUnattached(deps.chatHistory, id, formatDataRetentionNotice(facts));
    } catch (err) {
      console.warn(`[data-retention] transcript notice failed for ${id}:`, getMessage(err));
    }
    try {
      deps.sessionManager.appendPendingAgentNotice(id, formatDataRetentionAgentNotice(facts));
    } catch (err) {
      console.warn(`[data-retention] agent notice failed for ${id}:`, getMessage(err));
    }
  }

  if (failures.length > 0) {
    console.warn(`[data-retention] deletion incomplete for ${id}: ${failures.join("; ")}`);
    // What is left keeps a size, so a later pass deletes it and reports it.
    deps.sessionManager.setRetainedData(id, totalBytes(await measure(dirs)), iso());
    return;
  }
  deps.sessionManager.setRetainedData(id, 0, iso());
}

export async function sweepRetainedSessionData(
  deps: DataRetentionSweepDeps,
): Promise<DataRetentionSweepResult> {
  const result: DataRetentionSweepResult = { measured: 0, sessionsDeleted: 0, bytesDeleted: 0 };
  const config = deps.sessionManager.dataRetention;
  if (config.days <= 0) return result;
  const now = deps.now ?? Date.now;
  const paceMs = deps.paceMs ?? 0;

  const sessions = deps.sessionManager.listAll();
  const isDone = doneSessionTest(sessions);
  for (const listed of sessions) {
    const done = isDone(listed);
    if (!isUnderDataRetention(listed, done)) continue;
    const dirs = retainedDataDirs(listed, deps.sessionsRoot);
    if (!dirs) continue;
    try {
      let session = listed;
      if (retainedDataSizeIsStale(listed, done)) {
        // A turn that started before the merge can still write to /persist.
        if (deps.isSessionLive(listed.id)) continue;
        const bytes = totalBytes(await measure(dirs));
        const measuredAt = new Date(now()).toISOString();
        deps.sessionManager.setRetainedData(listed.id, bytes, measuredAt);
        result.measured += 1;
        session = { ...listed, retainedDataBytes: bytes, retainedDataMeasuredAt: measuredAt };
      }
      const dueAt = dataDeletionTimeMs(session, done, config);
      if (dueAt === undefined || dueAt > now()) continue;
      await sleep(paceMs);
      await deleteDueSession(listed.id, deps, now, result);
    } catch (err) {
      console.warn(`[data-retention] sweep failed for ${listed.id}:`, getMessage(err));
    }
  }

  if (result.measured > 0 || result.sessionsDeleted > 0) deps.onSessionsChanged?.();
  if (result.sessionsDeleted > 0) {
    console.log(
      `[data-retention] deleted the kept files of ${result.sessionsDeleted} session(s), ${formatBytes(result.bytesDeleted)}`,
    );
  }
  return result;
}
