/**
 * docs/252 phase 9 (req 14) — the declared harness set.
 *
 * The distinction under test throughout is `null` (nothing declared → fall back to
 * probing $PATH) versus `[]` (declared, and empty). Collapsing them would make a
 * missing or corrupt report silently empty the picker on every existing
 * deployment, which is the failure this file exists to prevent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INSTALL_REPORT_PATH,
  installReportPath,
  isHarnessInstalled,
  parseInstallReport,
  readInstalledHarnesses,
} from "./installed-harnesses.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-harnesses-"));
  // The parser warns on every rejection; silence it so a passing run is quiet.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeReport(contents: string): string {
  const file = path.join(tmpDir, "installed.json");
  fs.writeFileSync(file, contents);
  return file;
}

describe("parseInstallReport", () => {
  it("reads the declared harnesses", () => {
    expect(parseInstallReport('{"harnesses":["claude","codex"]}')).toEqual(["claude", "codex"]);
  });

  it("preserves a single-harness install", () => {
    expect(parseInstallReport('{"harnesses":["codex"]}')).toEqual(["codex"]);
  });

  it("returns null (not []) for malformed JSON, so the caller falls back to probing", () => {
    expect(parseInstallReport("not json")).toBeNull();
  });

  it("returns null when the report has no harnesses array", () => {
    expect(parseInstallReport('{"agents":["claude"]}')).toBeNull();
  });

  it("ignores ids this build does not know, keeping the rest", () => {
    // An image can outlive a harness rename; a stale id must not poison the set.
    expect(parseInstallReport('{"harnesses":["claude","cursor"]}')).toEqual(["claude"]);
  });

  it("returns null when it named harnesses but none are recognizable", () => {
    // Distinct from the case above: nothing survived, so the report tells us
    // nothing. Answering `[]` would disable every harness on an install that has
    // them — the installer never writes a selection with no recognizable id.
    expect(parseInstallReport('{"harnesses":["cursor"]}')).toBeNull();
    expect(parseInstallReport('{"harnesses":[null]}')).toBeNull();
    expect(parseInstallReport('{"harnesses":[{"id":"claude"}]}')).toBeNull();
  });

  it("de-duplicates", () => {
    expect(parseInstallReport('{"harnesses":["codex","codex"]}')).toEqual(["codex"]);
  });

  it("treats an explicitly empty declaration as empty, not as absent", () => {
    expect(parseInstallReport('{"harnesses":[]}')).toEqual([]);
  });
});

describe("readInstalledHarnesses", () => {
  it("returns null when no report exists", () => {
    expect(readInstalledHarnesses(path.join(tmpDir, "absent.json"))).toBeNull();
  });

  it("reads the report the image build wrote", () => {
    expect(readInstalledHarnesses(writeReport('{"harnesses":["claude"]}'))).toEqual(["claude"]);
  });
});

describe("installReportPath", () => {
  it("defaults to the path the installer script writes", () => {
    expect(installReportPath({} as NodeJS.ProcessEnv)).toBe(DEFAULT_INSTALL_REPORT_PATH);
  });

  it("honours SHIPIT_AGENTS_INSTALL_REPORT", () => {
    expect(installReportPath({ SHIPIT_AGENTS_INSTALL_REPORT: "/tmp/x.json" } as NodeJS.ProcessEnv))
      .toBe("/tmp/x.json");
  });
});

describe("isHarnessInstalled", () => {
  it("is true for a declared harness", () => {
    expect(isHarnessInstalled("codex", ["claude", "codex"])).toBe(true);
  });

  it("is false for one the deployment left out", () => {
    expect(isHarnessInstalled("claude", ["codex"])).toBe(false);
  });

  it("is true when nothing is declared — a checkout keeps today's behaviour", () => {
    expect(isHarnessInstalled("claude", null)).toBe(true);
  });
});
