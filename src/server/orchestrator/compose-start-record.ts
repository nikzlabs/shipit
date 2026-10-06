import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ComposeStartModel } from "./compose-cli.js";

const STARTS_SUBDIR = "starts";
const RECORD_FILE = "started-by.json";
const START_ID = /^[a-z0-9]+-[0-9a-f]+$/;

export interface ComposeStartFiles {
  id: string;
  snapshotFile: string;
  overrideFile: string;
}

interface RecordEntry {
  start: string;
  snapshot: boolean;
}

export type RecordedStart =
  | { recorded: false }
  /** `model` is null when the start's files are gone. */
  | { recorded: true; model: ComposeStartModel | null };

// Process-wide, not held by a caller: two ServiceManagers can serve one session at once
// (docs/318-compose-remaining-escapes, "Who owns a start's files"). Start ids are unique across sessions.
const startsInFlight = new Set<string>();

/**
 * Which start's snapshot and override last started each service, in a root-only file under
 * `compose/`, so `stop` loads the model the service runs from and Compose runs its `pre_stop` hook
 * (docs/318-compose-remaining-escapes, Mechanism 1). A container label would change Compose's
 * configuration hash on every start and recreate unchanged services.
 *
 * Every method is synchronous on purpose: `record` and `clear` are read-modify-writes of one file
 * that two instances share, and an `await` inside either would let one drop the other's entry.
 */
export class ComposeStartRecord {
  constructor(private readonly composeStateDir: string) {}

  /**
   * A new, empty directory for one start's files, never reused. The start is in flight, and its
   * files are kept, until `release` or `discard`.
   */
  allocate(): ComposeStartFiles {
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const dir = this.startDir(id);
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { mode: 0o700 });
    startsInFlight.add(id);
    return { id, snapshotFile: path.join(dir, "snapshot.yml"), overrideFile: path.join(dir, "override.yml") };
  }

  record(services: readonly string[], start: { id: string; snapshot: boolean }): void {
    const entries = this.read();
    for (const name of services) entries[name] = { start: start.id, snapshot: start.snapshot };
    this.write(entries);
  }

  lookup(service: string): RecordedStart {
    const entry = this.read()[service];
    if (!entry) return { recorded: false };
    const dir = this.startDir(entry.start);
    const model: ComposeStartModel = {
      ...(entry.snapshot ? { snapshotFile: path.join(dir, "snapshot.yml") } : {}),
      overrideFile: path.join(dir, "override.yml"),
    };
    const files = [model.snapshotFile, model.overrideFile].filter((f): f is string => f !== undefined);
    return { recorded: true, model: files.every((f) => fs.existsSync(f)) ? model : null };
  }

  /** The start has ended; from now on only the record keeps its files. */
  release(id: string): void {
    startsInFlight.delete(id);
  }

  /** Removes the files of every start that the record no longer names and that is not in flight. */
  prune(): void {
    const keep = new Set([...Object.values(this.read()).map((e) => e.start), ...startsInFlight]);
    let ids: string[];
    try {
      ids = fs.readdirSync(path.join(this.composeStateDir, STARTS_SUBDIR));
    } catch {
      return;
    }
    for (const id of ids) {
      if (!keep.has(id)) this.discard(id);
    }
  }

  discard(id: string): void {
    if (!START_ID.test(id)) return;
    this.release(id);
    fs.rmSync(this.startDir(id), { recursive: true, force: true });
  }

  /**
   * After a full stop: no container remains that an ended start's files describe. A start still in
   * flight keeps its entries, because its `up` may create containers after the stop's `down`.
   */
  clear(): void {
    const kept = Object.entries(this.read()).filter(([, entry]) => startsInFlight.has(entry.start));
    if (kept.length > 0) this.write(Object.fromEntries(kept));
    else fs.rmSync(path.join(this.composeStateDir, RECORD_FILE), { force: true });
    this.prune();
  }

  private startDir(id: string): string {
    return path.join(this.composeStateDir, STARTS_SUBDIR, id);
  }

  private read(): Record<string, RecordEntry> {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.composeStateDir, RECORD_FILE), "utf-8");
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      const out: Record<string, RecordEntry> = {};
      if (!parsed || typeof parsed !== "object") return out;
      for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object") continue;
        const { start, snapshot } = entry as Record<string, unknown>;
        if (typeof start === "string" && START_ID.test(start)) out[name] = { start, snapshot: snapshot === true };
      }
      return out;
    } catch (err) {
      console.warn(`[compose] could not read ${RECORD_FILE}; stops run without a model:`, (err as Error).message);
      return {};
    }
  }

  private write(entries: Record<string, RecordEntry>): void {
    fs.mkdirSync(this.composeStateDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.composeStateDir, RECORD_FILE);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}
