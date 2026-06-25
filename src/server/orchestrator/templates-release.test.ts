import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RELEASE_NOTES_CONFIG_PATH,
  RELEASE_VERSION_HELPER_PATH,
  RELEASE_VERSION_WRITER_PATH,
  RELEASE_WORKFLOW_PATH,
  renderReleaseNotesConfig,
  renderReleaseScaffold,
  renderReleaseVersionHelper,
  renderReleaseVersionWriter,
  renderReleaseWorkflow,
} from "./templates-release.js";
import {
  detectVersionSource,
  readCargoTomlVersion,
  readPackageJsonVersion,
  readPyprojectVersion,
  readVersionFile,
  writeVersionToSource,
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

  it("forward-ports the released version onto the default branch via a sync job", () => {
    const wf = renderReleaseWorkflow({ versionSource: "package.json", branch: "stable" });
    expect(wf).toContain("sync-default-branch:");
    // Runs only after a successful publish on the branch path.
    expect(wf).toContain("needs: [resolve, publish]");
    expect(wf).toContain("needs.resolve.outputs.is_branch == 'true'");
    // Resolves the default branch at runtime (no extra config; main/master).
    expect(wf).toContain("gh repo view --json defaultBranchRef");
    // Skips when the default branch IS the maintenance branch.
    expect(wf).toContain('if [ "$DEFAULT_BRANCH" = "$RELEASE_BRANCH" ]');
    // Bumps via the shared write helper (same logic ShipIt uses), not ad-hoc edits.
    expect(wf).toContain(`node ${RELEASE_VERSION_WRITER_PATH} 'package.json'`);
    // Opens a PR (not a direct push) and needs pull-requests: write.
    expect(wf).toContain("pull-requests: write");
    expect(wf).toContain('gh pr create --base "$DEFAULT_BRANCH"');
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
  it("returns all four artifacts keyed by their repo-relative path", () => {
    const files = renderReleaseScaffold({ versionSource: "package.json", branch: "stable", prerelease: true });
    expect(Object.keys(files).sort()).toEqual(
      [
        RELEASE_WORKFLOW_PATH,
        RELEASE_NOTES_CONFIG_PATH,
        RELEASE_VERSION_HELPER_PATH,
        RELEASE_VERSION_WRITER_PATH,
      ].sort(),
    );
    expect(files[RELEASE_VERSION_HELPER_PATH]).toBe(renderReleaseVersionHelper());
    expect(files[RELEASE_VERSION_WRITER_PATH]).toBe(renderReleaseVersionWriter());
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

// The scaffolded `sync-default-branch` job writes the released version onto the
// default branch with shipit-write-version.mjs. It must produce byte-identical
// output to release-version.ts's `writeVersionToSource` — otherwise the synced
// version file could differ from what the release command writes. Prove it by
// running the generated writer and the in-process writer on identical fixtures.
describe("shipit-write-version.mjs ⇔ release-version.ts consistency", () => {
  let helperDir: string;
  let writerPath: string;

  beforeEach(() => {
    helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-release-writer-"));
    writerPath = path.join(helperDir, "shipit-write-version.mjs");
    fs.writeFileSync(writerPath, renderReleaseVersionWriter(), "utf8");
  });

  afterEach(() => {
    fs.rmSync(helperDir, { recursive: true, force: true });
  });

  // Write `newVersion` into `filename` (content `seed`) two ways — via the
  // generated helper and via writeVersionToSource — in separate dirs, and assert
  // the resulting files are byte-identical.
  const assertWritesMatch = (filename: string, seed: string, newVersion: string): void => {
    const helperWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-writer-h-"));
    const inProcDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-writer-p-"));
    try {
      fs.writeFileSync(path.join(helperWorkDir, filename), seed, "utf8");
      fs.writeFileSync(path.join(inProcDir, filename), seed, "utf8");

      execFileSync("node", [writerPath, filename, newVersion], { cwd: helperWorkDir, encoding: "utf8" });
      const detected = detectVersionSource(inProcDir);
      expect(detected).not.toBeNull();
      writeVersionToSource(detected!, newVersion);

      expect(fs.readFileSync(path.join(helperWorkDir, filename), "utf8")).toBe(
        fs.readFileSync(path.join(inProcDir, filename), "utf8"),
      );
    } finally {
      fs.rmSync(helperWorkDir, { recursive: true, force: true });
      fs.rmSync(inProcDir, { recursive: true, force: true });
    }
  };

  it("writes package.json identically (indent + trailing newline preserved)", () => {
    assertWritesMatch("package.json", '{\n  "name": "x",\n  "version": "1.2.3"\n}\n', "1.3.0");
  });

  it("writes Cargo.toml identically", () => {
    assertWritesMatch(
      "Cargo.toml",
      '[package]\nname = "x"\nversion = "0.9.1"\n\n[dependencies]\nserde = "1"\n',
      "0.10.0",
    );
  });

  it("writes pyproject.toml (PEP 621) identically", () => {
    assertWritesMatch("pyproject.toml", '[project]\nname = "x"\nversion = "2.0.0"\n', "2.1.0");
  });

  it("writes pyproject.toml (Poetry) identically", () => {
    assertWritesMatch("pyproject.toml", '[tool.poetry]\nname = "x"\nversion = "3.1.4"\n', "3.2.0");
  });

  it("writes a VERSION file identically", () => {
    assertWritesMatch("VERSION", "4.5.6\n", "4.6.0");
  });

  it("bumps an adjacent package-lock.json root version alongside package.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-writer-lock-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), '{\n  "name": "x",\n  "version": "1.0.0"\n}\n', "utf8");
      fs.writeFileSync(
        path.join(dir, "package-lock.json"),
        '{\n  "name": "x",\n  "version": "1.0.0",\n  "packages": {\n    "": {\n      "version": "1.0.0"\n    }\n  }\n}\n',
        "utf8",
      );
      execFileSync("node", [writerPath, "package.json", "1.1.0"], { cwd: dir, encoding: "utf8" });
      const lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8")) as {
        version: string;
        packages: Record<string, { version: string }>;
      };
      expect(lock.version).toBe("1.1.0");
      expect(lock.packages[""].version).toBe("1.1.0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when the version field cannot be located", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-writer-nofield-"));
    try {
      fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "x"\n', "utf8");
      expect(() =>
        execFileSync("node", [writerPath, "Cargo.toml", "1.0.0"], { cwd: dir, encoding: "utf8" }),
      ).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
