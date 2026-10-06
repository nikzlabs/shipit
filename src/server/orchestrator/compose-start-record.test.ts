import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ComposeStartRecord } from "./compose-start-record.js";

describe("ComposeStartRecord (docs/318)", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function record(): { rec: ComposeStartRecord; dir: string } {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compose-start-record-"));
    const dir = path.join(tmp, "state", "compose");
    return { rec: new ComposeStartRecord(dir), dir };
  }

  function writePair(files: { snapshotFile: string; overrideFile: string }, snapshot = true): void {
    if (snapshot) fs.writeFileSync(files.snapshotFile, "services: {}\n");
    fs.writeFileSync(files.overrideFile, "services: {}\n");
  }

  it("gives each start its own root-only directory", () => {
    const { rec, dir } = record();
    const a = rec.allocate();
    const b = rec.allocate();
    expect(a.id).not.toBe(b.id);
    expect(path.dirname(a.snapshotFile)).toBe(path.join(dir, "starts", a.id));
    expect(fs.statSync(path.dirname(a.overrideFile)).mode & 0o777).toBe(0o700);
  });

  it("finds the start that last started a service, in a root-only file", () => {
    const { rec, dir } = record();
    const first = rec.allocate();
    const second = rec.allocate();
    writePair(first);
    writePair(second);
    rec.record(["web", "db"], { id: first.id, snapshot: true });
    rec.record(["web"], { id: second.id, snapshot: true });

    expect(rec.lookup("web")).toEqual({
      recorded: true,
      model: { snapshotFile: second.snapshotFile, overrideFile: second.overrideFile },
    });
    expect(rec.lookup("db")).toEqual({
      recorded: true,
      model: { snapshotFile: first.snapshotFile, overrideFile: first.overrideFile },
    });
    expect(rec.lookup("worker")).toEqual({ recorded: false });
    expect(fs.statSync(path.join(dir, "started-by.json")).mode & 0o777).toBe(0o600);
  });

  it("gives a plugin-only start's override alone", () => {
    const { rec } = record();
    const start = rec.allocate();
    writePair(start, false);
    rec.record(["probe"], { id: start.id, snapshot: false });
    expect(rec.lookup("probe")).toEqual({ recorded: true, model: { overrideFile: start.overrideFile } });
  });

  it("reports no model once the start's files are gone", () => {
    const { rec } = record();
    const start = rec.allocate();
    writePair(start);
    rec.record(["web"], { id: start.id, snapshot: true });
    fs.rmSync(start.snapshotFile);
    expect(rec.lookup("web")).toEqual({ recorded: true, model: null });
  });

  it("keeps a start's files while the record names it or it is in flight", () => {
    const { rec } = record();
    const kept = rec.allocate();
    const replaced = rec.allocate();
    const running = rec.allocate();
    for (const s of [kept, replaced, running]) writePair(s);
    rec.record(["web"], { id: replaced.id, snapshot: true });
    rec.record(["web", "db"], { id: kept.id, snapshot: true });
    rec.release(kept.id);
    rec.release(replaced.id);

    rec.prune();

    expect(fs.existsSync(kept.snapshotFile)).toBe(true);
    expect(fs.existsSync(running.snapshotFile)).toBe(true);
    expect(fs.existsSync(path.dirname(replaced.snapshotFile))).toBe(false);

    rec.release(running.id);
    rec.prune();
    expect(fs.existsSync(path.dirname(running.snapshotFile))).toBe(false);
  });

  it("forgets every ended start on clear", () => {
    const { rec, dir } = record();
    const done = rec.allocate();
    writePair(done);
    rec.record(["web"], { id: done.id, snapshot: true });
    rec.release(done.id);

    rec.clear();

    expect(rec.lookup("web")).toEqual({ recorded: false });
    expect(fs.existsSync(path.dirname(done.snapshotFile))).toBe(false);
    expect(fs.existsSync(path.join(dir, "started-by.json"))).toBe(false);
  });

  it("discards a refused start's files", () => {
    const { rec } = record();
    const refused = rec.allocate();
    rec.discard(refused.id);
    expect(fs.existsSync(path.dirname(refused.snapshotFile))).toBe(false);
  });

  describe("two instances over one session", () => {
    function pair(): { outgoing: ComposeStartRecord; incoming: ComposeStartRecord } {
      const { rec, dir } = record();
      return { outgoing: rec, incoming: new ComposeStartRecord(dir) };
    }

    it("does not prune a start the other instance has allocated but not yet recorded", () => {
      const { outgoing, incoming } = pair();
      const own = outgoing.allocate();
      const theirs = incoming.allocate();
      writePair(theirs);

      outgoing.release(own.id);
      outgoing.prune();

      expect(fs.existsSync(theirs.snapshotFile)).toBe(true);
      expect(fs.existsSync(theirs.overrideFile)).toBe(true);
    });

    it("keeps the other instance's in-flight start, files and record entries, on clear", () => {
      const { outgoing, incoming } = pair();
      const old = outgoing.allocate();
      writePair(old);
      outgoing.record(["web", "db"], { id: old.id, snapshot: true });
      outgoing.release(old.id);
      const theirs = incoming.allocate();
      writePair(theirs);
      incoming.record(["web"], { id: theirs.id, snapshot: true });

      outgoing.clear();

      expect(incoming.lookup("web")).toEqual({
        recorded: true,
        model: { snapshotFile: theirs.snapshotFile, overrideFile: theirs.overrideFile },
      });
      expect(incoming.lookup("db")).toEqual({ recorded: false });
      expect(fs.existsSync(path.dirname(old.snapshotFile))).toBe(false);
    });

    it("keeps an unrecorded in-flight start's files on clear, so its later record still resolves", () => {
      const { outgoing, incoming } = pair();
      const theirs = incoming.allocate();
      writePair(theirs);

      outgoing.clear();
      incoming.record(["web"], { id: theirs.id, snapshot: true });
      incoming.release(theirs.id);
      incoming.prune();

      expect(incoming.lookup("web")).toEqual({
        recorded: true,
        model: { snapshotFile: theirs.snapshotFile, overrideFile: theirs.overrideFile },
      });
    });
  });

  it("reads an unreadable record as empty, and ignores entries that name no start", () => {
    const { rec, dir } = record();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "started-by.json"), "{not json");
    expect(rec.lookup("web")).toEqual({ recorded: false });
    fs.writeFileSync(path.join(dir, "started-by.json"), JSON.stringify({ web: { start: "../../escape", snapshot: true } }));
    expect(rec.lookup("web")).toEqual({ recorded: false });
  });
});
