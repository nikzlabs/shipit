import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RELEASE_NOTES_CONFIG_PATH,
  RELEASE_VERSION_HELPER_PATH,
  RELEASE_WORKFLOW_PATH,
  renderReleaseNotesConfig,
  renderReleaseScaffold,
  renderReleaseVersionHelper,
  renderReleaseWorkflow,
} from "./templates-release.js";
import {
  readCargoTomlVersion,
  readPackageJsonVersion,
  readPyprojectVersion,
  readVersionFile,
} from "./release-version.js";

describe("renderReleaseWorkflow", () => {
  it("always triggers on the release branch and runs the resolve + publish jobs", () => {
    const wf = renderReleaseWorkflow({ versionSource: "package.json", branch: "stable" });
    expect(wf).toContain("name: Release");
    expect(wf).toContain("branches: ['stable']");
    expect(wf).toContain("resolve:");
    expect(wf).toContain("publish:");
    // The branch path derives the tag via the shared Node helper, not ad-hoc bash.
    expect(wf).toContain(`node ${RELEASE_VERSION_HELPER_PATH} 'package.json'`);
    // publish is serialized per resolved tag.
    expect(wf).toContain("concurrency:");
    expect(wf).toContain("group: release-");
    expect(wf).toContain("cancel-in-progress: false");
  });

  it("omits the tag path + version-guard when prerelease is disabled", () => {
    const wf = renderReleaseWorkflow({ versionSource: "VERSION", branch: "stable" });
    expect(wf).not.toContain("tags: ['v*']");
    expect(wf).not.toContain("version-guard:");
    expect(wf).toContain("needs: [resolve]");
  });

  it("includes the tag path + version-guard when prerelease is enabled", () => {
    const wf = renderReleaseWorkflow({ versionSource: "package.json", branch: "stable", prerelease: true });
    expect(wf).toContain("tags: ['v*']");
    expect(wf).toContain("version-guard:");
    expect(wf).toContain("refs/tags/*");
    expect(wf).toContain("--prerelease");
    expect(wf).toContain("needs: [resolve, version-guard]");
  });

  it("emits a gate job only when a gate command is given, and threads it verbatim", () => {
    const without = renderReleaseWorkflow({ versionSource: "Cargo.toml", branch: "release" });
    expect(without).not.toContain("gate:");

    const withGate = renderReleaseWorkflow({ versionSource: "Cargo.toml", branch: "release", gate: "cargo test" });
    expect(withGate).toContain("gate:");
    expect(withGate).toContain("- run: cargo test");
    expect(withGate).toContain("needs: [resolve, gate]");
  });

  it("threads the branch name and version source into the derive + reject logic", () => {
    const wf = renderReleaseWorkflow({ versionSource: "pyproject.toml", branch: "main" });
    expect(wf).toContain("branches: ['main']");
    expect(wf).toContain(`node ${RELEASE_VERSION_HELPER_PATH} 'pyproject.toml'`);
    // Final-only branch: a prerelease version is rejected on the branch path.
    expect(wf).toContain("Branch carries a prerelease version");
  });
});

describe("renderReleaseNotesConfig", () => {
  it("renders the categorized changelog with a catch-all last", () => {
    const cfg = renderReleaseNotesConfig();
    expect(cfg).toContain("changelog:");
    expect(cfg).toContain("🚀 Features");
    // The catch-all must be the final category so nothing is dropped.
    const catchAllIdx = cfg.indexOf('- "*"');
    expect(catchAllIdx).toBeGreaterThan(-1);
    expect(cfg.indexOf("🚀 Features")).toBeLessThan(catchAllIdx);
  });
});

describe("renderReleaseScaffold", () => {
  it("returns all three artifacts keyed by their repo-relative path", () => {
    const files = renderReleaseScaffold({ versionSource: "package.json", branch: "stable", prerelease: true });
    expect(Object.keys(files).sort()).toEqual(
      [RELEASE_WORKFLOW_PATH, RELEASE_NOTES_CONFIG_PATH, RELEASE_VERSION_HELPER_PATH].sort(),
    );
    expect(files[RELEASE_VERSION_HELPER_PATH]).toBe(renderReleaseVersionHelper());
  });
});

// The scaffolded CI must read the version with the SAME logic as
// release-version.ts (docs/214) — otherwise write-side and read-side could
// disagree and CI would tag the wrong version silently. Prove it by running the
// generated helper and comparing to release-version.ts's readers on the same
// fixtures.
describe("shipit-read-version.mjs ⇔ release-version.ts consistency", () => {
  let dir: string;
  let helperPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-release-helper-"));
    helperPath = path.join(dir, "shipit-read-version.mjs");
    fs.writeFileSync(helperPath, renderReleaseVersionHelper(), "utf8");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runHelper = (source: string): string =>
    execFileSync("node", [helperPath, source], { cwd: dir, encoding: "utf8" }).trim();

  it("reads package.json identically", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.2.3" }), "utf8");
    expect(runHelper("package.json")).toBe("1.2.3");
    expect(runHelper("package.json")).toBe(readPackageJsonVersion(dir));
  });

  it("reads Cargo.toml identically", () => {
    fs.writeFileSync(
      path.join(dir, "Cargo.toml"),
      '[package]\nname = "x"\nversion = "0.9.1"\n\n[dependencies]\nserde = "1"\n',
      "utf8",
    );
    expect(runHelper("Cargo.toml")).toBe("0.9.1");
    expect(runHelper("Cargo.toml")).toBe(readCargoTomlVersion(dir));
  });

  it("reads pyproject.toml (PEP 621) identically", () => {
    fs.writeFileSync(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "x"\nversion = "2.0.0"\n',
      "utf8",
    );
    expect(runHelper("pyproject.toml")).toBe("2.0.0");
    expect(runHelper("pyproject.toml")).toBe(readPyprojectVersion(dir));
  });

  it("reads pyproject.toml (Poetry) identically", () => {
    fs.writeFileSync(
      path.join(dir, "pyproject.toml"),
      '[tool.poetry]\nname = "x"\nversion = "3.1.4"\n',
      "utf8",
    );
    expect(runHelper("pyproject.toml")).toBe("3.1.4");
    expect(runHelper("pyproject.toml")).toBe(readPyprojectVersion(dir));
  });

  it("reads a VERSION file identically", () => {
    fs.writeFileSync(path.join(dir, "VERSION"), "4.5.6\n", "utf8");
    expect(runHelper("VERSION")).toBe("4.5.6");
    expect(runHelper("VERSION")).toBe(readVersionFile(dir));
  });

  it("exits non-zero when the version cannot be read", () => {
    expect(() => runHelper("package.json")).toThrow();
  });
});
