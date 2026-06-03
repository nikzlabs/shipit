import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSemVer,
  formatSemVer,
  computeNextVersion,
  readPackageJsonVersion,
  detectVersionSource,
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
