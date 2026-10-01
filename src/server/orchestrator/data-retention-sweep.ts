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
  /** A runner, a container or a Compose stack can have the directories mounted. */
  isSessionLive: (sessionId: string) => boolean;
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

export function retainedDataDirs(session: SessionInfo): RetainedDirs | null {
  const workspaceDir = session.workspaceDir;
  // In any other layout the siblings of the workspace are not this session's own dirs.
  if (!workspaceDir || path.basename(workspaceDir) !== SESSION_WORKSPACE_SUBDIR) return null;
  const root = path.dirname(workspaceDir);
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

// Counts files, not directories, so a tree of empty directories has no size.
async function treeBytes(dir: string): Promise<number> {
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
        total += st.blocks > 0 ? st.blocks * 512 : st.size;
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

// The directory itself stays: mounts and upload listings expect it, with its owner.
async function emptyDir(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : getMessage(err);
  }
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
  sizes: RetainedSizes;
  deletedAt: string;
  archived: boolean;
  config: DataRetentionConfig;
}

function periodReason(facts: DeletionFacts): string {
  const bytes = totalBytes(facts.sizes);
  const days = retentionPeriodDays(bytes, facts.config);
  const large = facts.config.largeDays > 0 && bytes >= facts.config.largeBytes;
  const state = facts.archived ? "was archived" : "was finished and not used";
  const scope = large ? ` for a session with ${formatBytes(facts.config.largeBytes)} or more of these files` : "";
  return `The session ${state} for ${days} days, which is the retention period${scope}.`;
}

export function formatDataRetentionNotice(facts: DeletionFacts): string {
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

export function formatDataRetentionAgentNotice(facts: DeletionFacts): string {
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
  // The measurement and the pacing were awaits: decide from the list as it is now.
  const sessions = deps.sessionManager.listAll();
  const session = sessions.find((s) => s.id === id);
  if (!session) return;
  const dueAt = dataDeletionTimeMs(session, doneSessionTest(sessions)(session), config);
  if (dueAt === undefined || dueAt > now()) return;
  if (deps.isSessionLive(id)) return;
  const dirs = retainedDataDirs(session);
  if (!dirs) return;

  const sizes = await measure(dirs);
  const failures: string[] = [];
  for (const dir of [dirs.persist, dirs.uploads]) {
    const message = await emptyDir(dir);
    if (message) failures.push(`${dir}: ${message}`);
  }
  if (dirs.checkout.length > 0 && session.workspaceDir) {
    const { failed } = await reclaimRegenerableSessionDirs(session.workspaceDir, { paceMs: deps.paceMs });
    failures.push(...failed.map((f) => `${f.dir}: ${f.message}`));
  }
  if (failures.length > 0) {
    // The stored size stays, so the next pass tries again and no notice claims a deletion.
    console.warn(`[data-retention] deletion incomplete for ${id}: ${failures.join("; ")}`);
    return;
  }

  const deletedAt = new Date(now()).toISOString();
  deps.sessionManager.setRetainedData(id, 0, deletedAt);
  if (totalBytes(sizes) === 0) return;
  result.sessionsDeleted += 1;
  result.bytesDeleted += totalBytes(sizes);
  const facts: DeletionFacts = { sizes, deletedAt, archived: session.userArchived === true, config };
  console.log(
    `[data-retention] ${id}: deleted ${formatBytes(totalBytes(sizes))} `
    + `(persist=${sizes.persist} uploads=${sizes.uploads} checkout=${sizes.checkout})`,
  );
  try {
    persistNoticeUnattached(deps.chatHistory, id, formatDataRetentionNotice(facts));
    deps.sessionManager.appendPendingAgentNotice(id, formatDataRetentionAgentNotice(facts));
  } catch (err) {
    console.warn(`[data-retention] notice failed for ${id}:`, getMessage(err));
  }
}

export async function sweepRetainedSessionData(
  deps: DataRetentionSweepDeps,
): Promise<DataRetentionSweepResult> {
  const result: DataRetentionSweepResult = { measured: 0, sessionsDeleted: 0, bytesDeleted: 0 };
  const config = deps.sessionManager.dataRetention;
  if (config.days <= 0 && config.largeDays <= 0) return result;
  const now = deps.now ?? Date.now;
  const paceMs = deps.paceMs ?? 0;

  const sessions = deps.sessionManager.listAll();
  const isDone = doneSessionTest(sessions);
  for (const listed of sessions) {
    const done = isDone(listed);
    if (!isUnderDataRetention(listed, done)) continue;
    const dirs = retainedDataDirs(listed);
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
