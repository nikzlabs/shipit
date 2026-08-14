/**
 * docs/262 — the generation record read across the orchestrator/container
 * boundary. These cases are about what the reader does with a file it cannot
 * trust: the container decides whether to expose a third party's checkout on
 * this answer, so every unexpected shape has to land on "no source".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PLUGIN_GENERATION_RECORD_FILE,
  readPluginGenerationRecord,
} from "./plugin-generation-record.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-record-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(body: string): void {
  fs.writeFileSync(path.join(dir, PLUGIN_GENERATION_RECORD_FILE), body);
}

describe("readPluginGenerationRecord", () => {
  it("reads the fields the container uses", () => {
    write(JSON.stringify({
      repoName: "tools", commit: "a".repeat(40), ref: "branch main", source: "acme/tools",
    }));
    expect(readPluginGenerationRecord(dir)).toEqual({
      repoName: "tools", commit: "a".repeat(40), ref: "branch main", source: "acme/tools",
    });
  });

  it("ignores fields it does not know", () => {
    // A container outlives an orchestrator restart, so it routinely reads
    // records a newer orchestrator wrote. An unknown key is data to skip.
    write(JSON.stringify({ repoName: "tools", commit: "abc", ref: "r", source: "acme/tools", futureField: 1 }));
    expect(readPluginGenerationRecord(dir)?.source).toBe("acme/tools");
  });

  it("returns null when there is no record", () => {
    expect(readPluginGenerationRecord(dir)).toBeNull();
    expect(readPluginGenerationRecord(path.join(dir, "nowhere"))).toBeNull();
  });

  it("returns null for a file that is not JSON", () => {
    write("not json at all");
    expect(readPluginGenerationRecord(dir)).toBeNull();
  });

  it("returns null for JSON that is not an object", () => {
    write("[1, 2, 3]");
    expect(readPluginGenerationRecord(dir)).toBeNull();
    write("null");
    expect(readPluginGenerationRecord(dir)).toBeNull();
  });

  it("omits `source` when the record predates the field", () => {
    // The legacy case, and the one the container must treat as "not this
    // declaration's": nothing here can prove whose generation it is.
    write(JSON.stringify({ repoName: "tools", commit: "abc", ref: "branch main" }));
    expect(readPluginGenerationRecord(dir)?.source).toBeUndefined();
  });

  it("omits `source` when it is present but not a string", () => {
    // Fail closed. Trusting a malformed field would let a corrupt file decide
    // that a foreign checkout belongs to this declaration.
    for (const value of [42, null, { owner: "acme" }, ["acme/tools"], true]) {
      write(JSON.stringify({ repoName: "tools", commit: "abc", ref: "r", source: value }));
      expect(readPluginGenerationRecord(dir)?.source).toBeUndefined();
    }
  });

  it("does not throw on a record whose other fields are wrong", () => {
    write(JSON.stringify({ repoName: 7, commit: null, ref: [], source: "acme/tools" }));
    expect(readPluginGenerationRecord(dir)).toEqual({
      repoName: "", commit: "", ref: "", source: "acme/tools",
    });
  });
});
