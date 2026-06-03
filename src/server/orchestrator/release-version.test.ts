import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSemVer,
  formatSemVer,
  computeNextVersion,
  readPackageJsonVersion,
  readCargoTomlVersion,
  readPyprojectVersion,
  readVersionFile,
  detectVersionSource,
  detectAllVersionSources,
} from "./release-version.js";

describe("parseSemVer", () => {
  it("parses a plain triple", () => {
    expect(parseSemVer("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });
  it("strips a leading v and build metadata", () => {
    expect(parseSemVer("v1.2.3+build.5")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });
  it("parses prerelease identifiers", () => {
    expect(parseSemVer("0.3.0-rc.2")).toEqual({ major: 0, minor: 3, patch: 0, prerelease: ["rc", "2"] });
  });
  it("rejects a non-triple", () => {
    expect(parseSemVer("1.2")).toBeNull();
    expect(parseSemVer("nope")).toBeNull();
    expect(parseSemVer("1.2.x")).toBeNull();
  });
});

describe("formatSemVer", () => {
  it("round-trips with prerelease", () => {
    expect(formatSemVer({ major: 0, minor: 3, patch: 0, prerelease: ["rc", "2"] })).toBe("0.3.0-rc.2");
  });
  it("omits the prerelease tail when empty", () => {
    expect(formatSemVer({ major: 1, minor: 0, patch: 0, prerelease: [] })).toBe("1.0.0");
  });
});

describe("computeNextVersion", () => {
  it("bumps patch/minor/major and drops prerelease tails", () => {
    expect(computeNextVersion("0.3.0", "patch")).toBe("0.3.1");
    expect(computeNextVersion("0.3.1", "minor")).toBe("0.4.0");
    expect(computeNextVersion("0.4.0", "major")).toBe("1.0.0");
    expect(computeNextVersion("0.3.0-rc.1", "minor")).toBe("0.4.0");
  });
  it("increments an existing rc counter for a prerelease bump", () => {
    expect(computeNextVersion("0.3.0-rc.1", "prerelease")).toBe("0.3.0-rc.2");
  });
  it("starts an rc lane off the next patch when not already a prerelease", () => {
    expect(computeNextVersion("0.3.0", "prerelease")).toBe("0.3.1-rc.1");
  });
  it("returns null for an unparseable version", () => {
    expect(computeNextVersion("bogus", "patch")).toBeNull();
  });
});

describe("package.json detection", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-ver-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the version field", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "2.5.1" }));
    expect(readPackageJsonVersion(dir)).toBe("2.5.1");
    expect(detectVersionSource(dir)).toEqual({
      source: "package.json",
      path: path.join(dir, "package.json"),
      version: "2.5.1",
    });
  });

  it("returns null when there is no package.json or no version", () => {
    expect(readPackageJsonVersion(dir)).toBeNull();
    expect(detectVersionSource(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(detectVersionSource(dir)).toBeNull();
  });

  it("returns null for malformed package.json", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
    expect(readPackageJsonVersion(dir)).toBeNull();
  });
});

describe("Cargo.toml detection", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-cargo-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads [package] version", () => {
    fs.writeFileSync(
      path.join(dir, "Cargo.toml"),
      '[package]\nname = "myapp"\nversion = "0.5.2"\nedition = "2021"\n',
    );
    expect(readCargoTomlVersion(dir)).toBe("0.5.2");
  });

  it("ignores version in other sections", () => {
    fs.writeFileSync(
      path.join(dir, "Cargo.toml"),
      '[dependencies]\nfoo = { version = "1.0" }\n',
    );
    expect(readCargoTomlVersion(dir)).toBeNull();
  });

  it("returns null when file absent", () => {
    expect(readCargoTomlVersion(dir)).toBeNull();
  });

  it("returns null when [package] has no version field", () => {
    fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "myapp"\n');
    expect(readCargoTomlVersion(dir)).toBeNull();
  });
});

describe("pyproject.toml detection", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-py-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads PEP 621 [project] version", () => {
    fs.writeFileSync(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "myapp"\nversion = "1.0.0"\n',
    );
    expect(readPyprojectVersion(dir)).toBe("1.0.0");
  });

  it("reads [tool.poetry] version when no [project] section", () => {
    fs.writeFileSync(
      path.join(dir, "pyproject.toml"),
      '[build-system]\nrequires = ["poetry-core"]\n\n[tool.poetry]\nname = "myapp"\nversion = "2.1.0"\n',
    );
    expect(readPyprojectVersion(dir)).toBe("2.1.0");
  });

  it("prefers [project] over [tool.poetry]", () => {
    fs.writeFileSync(
      path.join(dir, "pyproject.toml"),
      '[project]\nversion = "1.0.0"\n\n[tool.poetry]\nversion = "9.0.0"\n',
    );
    expect(readPyprojectVersion(dir)).toBe("1.0.0");
  });

  it("returns null when file absent", () => {
    expect(readPyprojectVersion(dir)).toBeNull();
  });
});

describe("VERSION file detection", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-vf-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads a plain version string", () => {
    fs.writeFileSync(path.join(dir, "VERSION"), "1.2.3\n");
    expect(readVersionFile(dir)).toBe("1.2.3");
  });

  it("reads only the first line", () => {
    fs.writeFileSync(path.join(dir, "VERSION"), "1.2.3\nextra stuff");
    expect(readVersionFile(dir)).toBe("1.2.3");
  });

  it("returns null when file absent", () => {
    expect(readVersionFile(dir)).toBeNull();
  });

  it("returns null for empty VERSION file", () => {
    fs.writeFileSync(path.join(dir, "VERSION"), "   \n");
    expect(readVersionFile(dir)).toBeNull();
  });
});

describe("detectAllVersionSources", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-all-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty array for an empty dir", () => {
    expect(detectAllVersionSources(dir)).toEqual([]);
  });

  it("returns one source when only package.json is present", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    const sources = detectAllVersionSources(dir);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.source).toBe("package.json");
    expect(sources[0]?.version).toBe("1.0.0");
  });

  it("returns multiple sources for a multi-ecosystem dir", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nversion = "0.9.0"\n');
    const sources = detectAllVersionSources(dir);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.source).toBe("package.json");
    expect(sources[1]?.source).toBe("Cargo.toml");
  });

  it("returns sources in priority order", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nversion = "0.5.0"\n');
    fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nversion = "0.3.0"\n');
    fs.writeFileSync(path.join(dir, "VERSION"), "0.1.0");
    const sources = detectAllVersionSources(dir);
    expect(sources.map((s) => s.source)).toEqual(["package.json", "Cargo.toml", "pyproject.toml", "VERSION"]);
  });
});
