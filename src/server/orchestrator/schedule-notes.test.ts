import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionInfo } from "../shared/types.js";
import { retainedDataDirs } from "./data-retention-sweep.js";
import { MAX_NOTE_READ_BYTES, mountableRunDir, ScheduleNotes } from "./schedule-notes.js";
import { ServiceError } from "./services/types.js";

const SCHEDULE = "5b1d0c4e-0000-4000-8000-000000000001";
const RUN = "9a7f3e2d-0000-4000-8000-000000000002";

let tmp: string;
let notes: ScheduleNotes;
let runDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-notes-"));
  notes = new ScheduleNotes(path.join(tmp, "schedules"));
  runDir = notes.runDir(SCHEDULE, RUN);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): void {
  const file = path.join(runDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function refusal(fn: () => unknown): ServiceError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    return err as ServiceError;
  }
  throw new Error("expected a refusal");
}

describe("ScheduleNotes — the run's folder", () => {
  it("creates the folder under <root>/<schedule>/runs/<run>, and hands it to the identity it is given", () => {
    const chown = vi.fn();
    const dir = notes.prepareRun(SCHEDULE, RUN, { uid: 4242, gid: 4243 }, { isRoot: () => true, chown });
    expect(dir).toBe(path.join(tmp, "schedules", SCHEDULE, "runs", RUN));
    expect(fs.lstatSync(dir).isDirectory()).toBe(true);
    expect(chown).toHaveBeenCalledWith(dir, { uid: 4242, gid: 4243 });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("hands nothing over without root, or without an identity", () => {
    const chown = vi.fn();
    notes.prepareRun(SCHEDULE, RUN, { uid: 4242, gid: 4243 }, { isRoot: () => false, chown });
    notes.prepareRun(SCHEDULE, RUN, null, { isRoot: () => true, chown });
    expect(chown).not.toHaveBeenCalled();
  });

  it("is idempotent, and keeps what the run wrote", () => {
    notes.prepareRun(SCHEDULE, RUN, null);
    write("a.md", "kept");
    notes.prepareRun(SCHEDULE, RUN, null);
    expect(fs.readFileSync(path.join(runDir, "a.md"), "utf8")).toBe("kept");
  });

  it("refuses a link where the run's folder should be", () => {
    fs.mkdirSync(path.dirname(runDir), { recursive: true });
    fs.symlinkSync(tmp, runDir);
    expect(() => notes.prepareRun(SCHEDULE, RUN, null)).toThrow(/is not a directory/);
    expect(notes.existingRunDir(SCHEDULE, RUN)).toBeNull();
  });

  it("refuses an id that is not one path segment", () => {
    expect(refusal(() => notes.runDir("../x", RUN)).statusCode).toBe(400);
    expect(refusal(() => notes.runDir(SCHEDULE, "a/b")).statusCode).toBe(400);
  });

  it("lives outside every session's tree, so archive retention never reaches it (docs/323)", () => {
    const sessionsRoot = path.join(tmp, "sessions");
    const session = {
      id: "s1",
      workspaceDir: path.join(sessionsRoot, "s1", "workspace"),
      kind: "sandbox",
      userArchived: true,
    } as SessionInfo;
    const retained = retainedDataDirs(session, sessionsRoot)!;
    for (const dir of [retained.persist, retained.uploads, ...retained.checkout]) {
      expect(path.relative(dir, runDir).startsWith("..")).toBe(true);
    }
    expect(path.relative(sessionsRoot, notes.root).startsWith("..")).toBe(true);
  });

  it("Delete removes the whole schedule's notes, and never follows a link out of them (req 32)", () => {
    notes.prepareRun(SCHEDULE, RUN, null);
    const outside = path.join(tmp, "outside.txt");
    fs.writeFileSync(outside, "keep");
    fs.symlinkSync(outside, path.join(runDir, "link"));
    write("a.md", "gone");
    notes.remove(SCHEDULE);
    expect(fs.existsSync(notes.scheduleDir(SCHEDULE))).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    expect(() => notes.remove(SCHEDULE)).not.toThrow();
  });
});

describe("ScheduleNotes — the runs with notes, and what a container mounts", () => {
  it("lists the runs that have a folder, and nothing for a schedule with none", () => {
    expect(notes.runIds(SCHEDULE)).toEqual([]);
    notes.prepareRun(SCHEDULE, RUN, null);
    fs.writeFileSync(path.join(path.dirname(runDir), "stray-file"), "");
    expect(notes.runIds(SCHEDULE)).toEqual([RUN]);
  });

  it("mounts a run's folder only while the folder and its schedule both exist (req 32)", () => {
    const run = { scheduleId: SCHEDULE, runId: RUN };
    const live = { get: () => ({}) };
    expect(mountableRunDir({ store: live, notes }, run)).toBeUndefined();
    notes.prepareRun(SCHEDULE, RUN, null);
    expect(mountableRunDir({ store: live, notes }, run)).toBe(runDir);
    expect(mountableRunDir({ store: { get: () => null }, notes }, run)).toBeUndefined();
  });
});

describe("ScheduleNotes.read — the one safe read", () => {
  beforeEach(() => {
    notes.prepareRun(SCHEDULE, RUN, null);
  });

  it("reads a file, also in a subfolder", () => {
    write("notes.md", "# Run\nall good\n");
    write("deep/er/log.txt", "one\ntwo");
    expect(notes.read(SCHEDULE, RUN, "notes.md")).toEqual({ path: "notes.md", size: 15, text: "# Run\nall good\n" });
    expect(notes.read(SCHEDULE, RUN, "deep/er/log.txt").text).toBe("one\ntwo");
  });

  it("refuses a link as the file, and as a folder on the way to it", () => {
    const secret = path.join(tmp, "secret.txt");
    fs.writeFileSync(secret, "host secret");
    fs.symlinkSync(secret, path.join(runDir, "leak.md"));
    fs.symlinkSync(tmp, path.join(runDir, "dir"));
    expect(refusal(() => notes.read(SCHEDULE, RUN, "leak.md")).message).toMatch(/link/);
    expect(refusal(() => notes.read(SCHEDULE, RUN, "dir/secret.txt")).message).toMatch(/link/);
  });

  it("refuses a folder swapped for a link between the checks and the open", () => {
    const secret = path.join(tmp, "outside");
    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(secret, "x.md"), "host secret");
    write("sub/x.md", "the run's own");
    const swap = () => {
      fs.renameSync(path.join(runDir, "sub"), path.join(runDir, "moved"));
      fs.symlinkSync(secret, path.join(runDir, "sub"));
    };
    const err = refusal(() => notes.read(SCHEDULE, RUN, "sub/x.md", MAX_NOTE_READ_BYTES, { afterChecks: swap }));
    expect(err.message).toMatch(/not inside the run's notes folder/);
  });

  it("refuses paths that leave the folder or are not paths", () => {
    for (const rel of ["../x", "/etc/passwd", "a/../../x", "", "a//b", "./a", "a\0b"]) {
      expect(refusal(() => notes.read(SCHEDULE, RUN, rel)).statusCode, rel).toBe(400);
    }
  });

  it("refuses what is not a regular file without blocking on it", () => {
    fs.mkdirSync(path.join(runDir, "folder"));
    execFileSync("mkfifo", [path.join(runDir, "pipe")]);
    expect(refusal(() => notes.read(SCHEDULE, RUN, "folder")).statusCode).toBe(400);
    expect(refusal(() => notes.read(SCHEDULE, RUN, "pipe")).message).toMatch(/not a file/);
  });

  it("answers 404 for a missing file, and for a run with no folder", () => {
    expect(refusal(() => notes.read(SCHEDULE, RUN, "nope.md")).statusCode).toBe(404);
    expect(refusal(() => notes.read(SCHEDULE, "11111111-0000-4000-8000-000000000000", "a.md")).statusCode).toBe(404);
  });

  it("gives the start of a long file without cutting a character, and no text for a binary one", () => {
    write("long.md", "ab€cd");
    // "ab" plus the first byte of "€" (three bytes): the half character is dropped.
    expect(notes.read(SCHEDULE, RUN, "long.md", 3)).toEqual({ path: "long.md", size: 7, text: "ab", truncated: true });
    expect(notes.read(SCHEDULE, RUN, "long.md", 5)).toMatchObject({ text: "ab€", truncated: true });
    write("image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    expect(notes.read(SCHEDULE, RUN, "image.png")).toEqual({ path: "image.png", size: 6 });
  });
});

describe("ScheduleNotes.listFiles", () => {
  it("lists the run's real files with their sizes, and leaves out links", () => {
    notes.prepareRun(SCHEDULE, RUN, null);
    write("b.md", "bb");
    write("a/c.txt", "c");
    fs.symlinkSync(path.join(tmp), path.join(runDir, "linked-dir"));
    fs.symlinkSync(path.join(runDir, "b.md"), path.join(runDir, "linked-file"));
    const listed = notes.listFiles(SCHEDULE, RUN)!;
    expect(listed.truncated).toBe(false);
    expect(listed.files.map((f) => [f.path, f.size])).toEqual([["a/c.txt", 1], ["b.md", 2]]);
  });

  it("lists at most 500 files, and says there are more", () => {
    notes.prepareRun(SCHEDULE, RUN, null);
    for (let i = 0; i < 520; i++) fs.writeFileSync(path.join(runDir, `n${String(i).padStart(3, "0")}.md`), "");
    const listed = notes.listFiles(SCHEDULE, RUN)!;
    expect([listed.files.length, listed.truncated]).toEqual([500, true]);
    expect(listed.files[0]!.path).toBe("n000.md");
  });

  it("marks the listing incomplete when files lie deeper than it walks", () => {
    notes.prepareRun(SCHEDULE, RUN, null);
    write(`${"d/".repeat(12)}deep.md`, "x");
    expect(notes.listFiles(SCHEDULE, RUN)).toEqual({ files: [], truncated: true });
  });

  it("is null for a run with no folder", () => {
    expect(notes.listFiles(SCHEDULE, RUN)).toBeNull();
  });
});
