import fs from "node:fs";
import path from "node:path";
import type { SessionIdentity } from "../shared/session-identity.js";
import type { ScheduleNoteContent, ScheduleNoteFile } from "../shared/types.js";
import { ServiceError } from "./services/types.js";

/**
 * docs/324-scheduled-sessions → "The run's first message and its notes" and "Seeing the notes"
 * (reqs 13, 27, 32). Each run has its own folder, `<root>/<schedule-id>/runs/<run-id>/`, owned by
 * the run session's identity and mounted into that run only. The folders belong to the schedule,
 * not to a session, so they live outside the session tree that archive retention sweeps.
 *
 * A run writes its folder, so any path in it can be a symlink to anything on the host. Every read
 * — for the user or for an agent — goes through {@link ScheduleNotes.read} and
 * {@link ScheduleNotes.listFiles}, which refuse a link at every step and check, after the open,
 * that what they opened is still inside the run's folder.
 */

/** Where a run's container sees its own notes folder. */
export const RUN_NOTES_CONTAINER_DIR = "/schedule/notes";

export const MAX_NOTE_READ_BYTES = 1024 * 1024;
const MAX_LISTED_FILES = 500;
const MAX_LISTED_DEPTH = 8;
// Bounds the walk, not just the answer: a run can fill its folder with any number of entries.
const MAX_VISITED_ENTRIES = 5000;

// Schedule and run ids are UUIDs; anything else must never become a path segment.
const ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface NotesHandoffDeps {
  isRoot: () => boolean;
  chown: (dir: string, owner: SessionIdentity) => void;
}

const handoffDefaults: NotesHandoffDeps = {
  isRoot: () => process.getuid?.() === 0,
  chown: (dir, owner) => fs.lchownSync(dir, owner.uid, owner.gid),
};

function checkId(id: string, what: string): string {
  if (!ID_SEGMENT.test(id)) throw new ServiceError(400, `${what} ${JSON.stringify(id)} is not a valid id.`);
  return id;
}

function isWithin(dir: string, candidate: string): boolean {
  return candidate === dir || candidate.startsWith(`${dir}${path.sep}`);
}

// Linux's /proc: the orchestrator runs only on Linux.
function openedPath(fd: number): string {
  return fs.readlinkSync(`/proc/self/fd/${fd}`);
}

function notFound(): ServiceError {
  return new ServiceError(404, "That notes file does not exist.");
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Relative, `/`-separated, and inside the folder by construction. */
function pathSegments(relPath: string): string[] {
  const parts = relPath.split("/");
  if (relPath === "" || relPath.includes("\0") || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new ServiceError(400, `${JSON.stringify(relPath)} is not a path inside the run's notes folder.`);
  }
  return parts;
}

/** A cut can fall inside a character; drop that character rather than call the file binary. */
function wholeCharacters(bytes: Buffer): Buffer {
  for (let back = 1; back <= Math.min(4, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

/** A file that is not valid UTF-8, or that holds a NUL byte, is shown by name and size only. */
function decodeText(buf: Buffer, truncated: boolean): string | undefined {
  const bytes = truncated ? wholeCharacters(buf) : buf;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * The folder a run session's container mounts: only while the folder and its schedule both
 * exist, so a deleted schedule's notes are never mounted, also if removing them failed (req 32).
 */
export function mountableRunDir(
  deps: { store: { get(id: string): unknown }; notes: Pick<ScheduleNotes, "existingRunDir"> },
  run: { scheduleId: string; runId: string },
): string | undefined {
  if (!deps.store.get(run.scheduleId)) return undefined;
  return deps.notes.existingRunDir(run.scheduleId, run.runId) ?? undefined;
}

export class ScheduleNotes {
  constructor(readonly root: string) {}

  scheduleDir(scheduleId: string): string {
    return path.join(this.root, checkId(scheduleId, "Schedule"));
  }

  runDir(scheduleId: string, runId: string): string {
    return path.join(this.scheduleDir(scheduleId), "runs", checkId(runId, "Run"));
  }

  /**
   * Creates the run's folder before its container starts, and hands it to the run session's
   * identity — passed in, because this path is outside the session's own tree. The parents stay
   * ShipIt's, so no run can replace its own folder or reach another's.
   */
  prepareRun(
    scheduleId: string,
    runId: string,
    owner: SessionIdentity | null,
    deps: NotesHandoffDeps = handoffDefaults,
  ): string {
    const dir = this.runDir(scheduleId, runId);
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o755 });
    for (const parent of [this.root, this.scheduleDir(scheduleId), path.dirname(dir)]) {
      if (!lstatOrNull(parent)?.isDirectory()) throw new Error(`${parent} is not a directory.`);
    }
    try {
      fs.mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (!lstatOrNull(dir)?.isDirectory()) throw new Error(`${dir} is not a directory.`);
    if (owner !== null && deps.isRoot()) {
      deps.chown(dir, owner);
      fs.chmodSync(dir, 0o700);
    }
    return dir;
  }

  /** The run's folder when it is there as a real directory; a container mounts only that. */
  existingRunDir(scheduleId: string, runId: string): string | null {
    const dir = this.runDir(scheduleId, runId);
    return lstatOrNull(dir)?.isDirectory() ? dir : null;
  }

  /** The runs of the schedule that have a notes folder. The `runs` folder is ShipIt's own. */
  runIds(scheduleId: string): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(this.scheduleDir(scheduleId), "runs"), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory() && ID_SEGMENT.test(e.name)).map((e) => e.name);
  }

  /** Req 32 — Delete removes the schedule's notes. `rmSync` unlinks a symlink, never its target. */
  remove(scheduleId: string): void {
    fs.rmSync(this.scheduleDir(scheduleId), { recursive: true, force: true });
  }

  /** The run's files, sorted by path; null when the run has no notes folder. */
  listFiles(scheduleId: string, runId: string): { files: ScheduleNoteFile[]; truncated: boolean } | null {
    const dir = this.existingRunDir(scheduleId, runId);
    if (!dir) return null;
    const realDir = fs.realpathSync(dir);
    const files: ScheduleNoteFile[] = [];
    let truncated = false;
    let visited = 0;
    const walk = (abs: string, prefix: string, depth: number): void => {
      let fd: number;
      try {
        fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      } catch {
        return;
      }
      try {
        if (!isWithin(realDir, openedPath(fd))) return;
        // Through the descriptor, so a directory swapped for a link after the open lists nothing else.
        const opened = `/proc/self/fd/${fd}`;
        const entries: fs.Dirent[] = [];
        const handle = fs.opendirSync(opened);
        try {
          for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
            if (++visited > MAX_VISITED_ENTRIES) {
              truncated = true;
              break;
            }
            entries.push(entry);
          }
        } finally {
          handle.closeSync();
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (files.length >= MAX_LISTED_FILES) {
            truncated = true;
            return;
          }
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (depth < MAX_LISTED_DEPTH) walk(path.join(abs, entry.name), rel, depth + 1);
            else truncated = true;
            continue;
          }
          if (!entry.isFile()) continue;
          const stat = lstatOrNull(path.join(opened, entry.name));
          if (stat?.isFile()) files.push({ path: rel, size: stat.size, modifiedAt: stat.mtime.toISOString() });
        }
      } finally {
        fs.closeSync(fd);
      }
    };
    walk(realDir, "", 0);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, truncated };
  }

  /**
   * The one read of a notes file: no symlink at any step (`lstat` on the way down, `O_NOFOLLOW`
   * on the open), and the opened file must still be inside the run's folder — a directory a run
   * swaps for a link between the checks and the open is caught there.
   */
  read(
    scheduleId: string,
    runId: string,
    relPath: string,
    maxBytes = MAX_NOTE_READ_BYTES,
    // Test seam: runs where a run could swap a folder for a link, between the checks and the open.
    hooks: { afterChecks?: () => void } = {},
  ): ScheduleNoteContent {
    const segments = pathSegments(relPath);
    const dir = this.existingRunDir(scheduleId, runId);
    if (!dir) throw new ServiceError(404, "This run has no notes folder.");
    const realDir = fs.realpathSync(dir);
    let current = realDir;
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = lstatOrNull(current);
      if (!stat) throw notFound();
      if (stat.isSymbolicLink()) throw new ServiceError(400, `${JSON.stringify(relPath)} is a link; notes are read only from real files.`);
      const last = index === segments.length - 1;
      if (!last && !stat.isDirectory()) throw notFound();
      // Never opened at all: a FIFO, a socket or a device node.
      if (last && !stat.isFile()) throw new ServiceError(400, `${JSON.stringify(relPath)} is not a file.`);
    }
    hooks.afterChecks?.();
    let fd: number;
    try {
      fd = fs.openSync(
        current,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw notFound();
      throw new ServiceError(400, `${JSON.stringify(relPath)} cannot be read (${code ?? "error"}).`);
    }
    try {
      if (!isWithin(realDir, openedPath(fd))) {
        throw new ServiceError(400, `${JSON.stringify(relPath)} is not inside the run's notes folder.`);
      }
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new ServiceError(400, `${JSON.stringify(relPath)} is not a file.`);
      const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
      let read = 0;
      while (read < buf.length) {
        const n = fs.readSync(fd, buf, read, buf.length - read, read);
        if (n === 0) break;
        read += n;
      }
      const truncated = stat.size > read;
      const text = decodeText(buf.subarray(0, read), truncated);
      return {
        path: relPath,
        size: stat.size,
        ...(text !== undefined ? { text } : {}),
        ...(text !== undefined && truncated ? { truncated: true as const } : {}),
      };
    } finally {
      fs.closeSync(fd);
    }
  }
}
