/**
 * docs/266 reqs 3, 4 — the durable answer to "what did the last install do".
 *
 * The property under test is not the JSON. It is that every one of the five
 * outcomes stays DISTINGUISHABLE after a round trip: "succeeded", "skipped"
 * and "not run" are three different things that all look like success from
 * outside, and telling them apart is the whole reason nikzlabs/shipit#2323's
 * author could not diagnose their own plugin.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeInstallRecord,
  installRecordPath,
  readInstallRecord,
  writeInstallRecord,
  type PluginInstallRecord,
} from "./plugin-install-record.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-install-record-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const RECORD: PluginInstallRecord = {
  commit: "a".repeat(40),
  at: "2026-08-16T10:00:00.000Z",
  outcome: "failed",
  detail: "install for `web` exited 1\nnpm ERR! missing script: build",
};

describe("plugin install record", () => {
  it("round-trips an attempt, including the failure output", async () => {
    writeInstallRecord(dir, "tools", RECORD);
    expect(readInstallRecord(dir, "tools")).toEqual(RECORD);
  });

  it("sits beside the generations, so it survives one that is never published", async () => {
    // The failing install's generation is deleted; this must not be under it.
    writeInstallRecord(dir, "tools", RECORD);
    expect(installRecordPath(dir, "tools")).toBe(path.join(dir, "tools", "last-install.json"));
    fs.rmSync(path.join(dir, "tools", "generations"), { recursive: true, force: true });
    expect(readInstallRecord(dir, "tools")?.outcome).toBe("failed");
  });

  it("keeps repositories separate", async () => {
    writeInstallRecord(dir, "tools", RECORD);
    writeInstallRecord(dir, "other", { ...RECORD, outcome: "succeeded" });
    expect(readInstallRecord(dir, "tools")?.outcome).toBe("failed");
    expect(readInstallRecord(dir, "other")?.outcome).toBe("succeeded");
  });

  it("answers null rather than throwing for a missing or corrupt record", async () => {
    expect(readInstallRecord(dir, "never-installed")).toBeNull();
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(installRecordPath(dir, "tools"), "{ not json");
    expect(readInstallRecord(dir, "tools")).toBeNull();
  });

  it("rejects a record whose outcome is not one this code knows", async () => {
    // A hand-edited or future-version file must not become an unhandled state
    // in the renderer, which switches exhaustively on the outcome.
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(
      installRecordPath(dir, "tools"),
      JSON.stringify({ commit: "a".repeat(40), at: "now", outcome: "probably-fine" }),
    );
    expect(readInstallRecord(dir, "tools")).toBeNull();
  });

  it("round-trips a SUCCESSFUL install's output", async () => {
    // planning#416 — the field that answers "it installed, so what did it
    // write?". `detail` cannot carry it: on a success there is no detail, and
    // on a failure it is prose a machine reader would have to parse.
    const succeeded: PluginInstallRecord = {
      commit: "b".repeat(40),
      at: "2026-08-16T10:00:00.000Z",
      outcome: "succeeded",
      output: "added 41 packages\nbuilt dist/index.js",
    };
    writeInstallRecord(dir, "tools", succeeded);
    expect(readInstallRecord(dir, "tools")).toEqual(succeeded);
  });

  it("drops an output that is not a string rather than carrying it through", async () => {
    // The file is on disk and hand-editable, and its output is quoted into
    // issues on other people's repositories. A non-string here would reach the
    // shim's JSON as whatever it is.
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(
      installRecordPath(dir, "tools"),
      JSON.stringify({ commit: "a".repeat(40), at: "now", outcome: "succeeded", output: { a: 1 } }),
    );
    expect(readInstallRecord(dir, "tools")?.output).toBeUndefined();
  });

  it("never throws when the tree cannot be written", async () => {
    // A diagnostic that can fail an install is worse than no diagnostic.
    const file = path.join(dir, "not-a-dir");
    fs.writeFileSync(file, "");
    expect(() => writeInstallRecord(file, "tools", RECORD)).not.toThrow();
  });

  it("renders each outcome as something a reader can act on", async () => {
    const at = "2026-08-16T10:00:00.000Z";
    const base = { commit: "b".repeat(40), at };
    // The absence names BOTH its causes: a repository that declares no install
    // writes nothing here, and so does one whose record was lost or predates the
    // feature. One of those is fine and the other is the reported bug, so this
    // line must not read as reassurance (review finding).
    expect(describeInstallRecord(null)).toContain("declares no install");
    expect(describeInstallRecord(null)).toContain("none has run since");
    expect(describeInstallRecord({ ...base, outcome: "succeeded" })).toContain("succeeded");
    // planning#416 — "succeeded" is exactly where the reader still has a
    // question, so the line says where the answer is. And says the opposite when
    // there is nothing there: pointing at an empty field costs a call and
    // answers nothing.
    expect(describeInstallRecord({ ...base, outcome: "succeeded", output: "added 41 packages" }))
      .toContain("--json");
    // "nothing was captured", never "it printed nothing": a best-effort log read
    // that failed is indistinguishable here from a silent install.
    expect(describeInstallRecord({ ...base, outcome: "succeeded" })).toContain("no output was captured");
    // The three that must never read as plain success.
    expect(describeInstallRecord({ ...base, outcome: "failed", detail: "exited 1" }))
      .toContain("FAILED");
    expect(describeInstallRecord({ ...base, outcome: "failed", detail: "exited 1" }))
      .toContain("exited 1");
    expect(describeInstallRecord({ ...base, outcome: "not-run" })).toContain("NOT RUN");
    expect(describeInstallRecord({ ...base, outcome: "skipped-store" })).toContain("nothing was run");
    expect(describeInstallRecord({ ...base, outcome: "skipped-stamp" })).toContain("already installed");
  });
});
