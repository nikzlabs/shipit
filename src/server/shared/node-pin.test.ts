/**
 * Tests for the Node version pin reader/matcher (docs/248, nikzlabs/shipit#1728).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareVersions,
  parseRange,
  parseVersion,
  pickBest,
  readNodePin,
  satisfies,
  type NodeVersion,
} from "./node-pin.js";

function v(text: string): NodeVersion {
  const parsed = parseVersion(text);
  if (!parsed) throw new Error(`bad test version ${text}`);
  return parsed;
}

/** Assert `version` matches `range`, failing loudly if the range won't parse. */
function matches(range: string, version: string): boolean {
  const spec = parseRange(range);
  if (!spec) throw new Error(`range did not parse: ${range}`);
  return satisfies(v(version), spec);
}

describe("parseVersion", () => {
  it("accepts the forms Node and .nvmrc actually write", () => {
    expect(parseVersion("v22.20.1")).toEqual({ major: 22, minor: 20, patch: 1 });
    expect(parseVersion("22.20.1")).toEqual({ major: 22, minor: 20, patch: 1 });
    expect(parseVersion(" 22.20.1 ")).toEqual({ major: 22, minor: 20, patch: 1 });
  });

  it("rejects non-versions", () => {
    expect(parseVersion("lts/jod")).toBeNull();
    expect(parseVersion("22")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions(v("22.0.0"), v("24.0.0"))).toBeLessThan(0);
    expect(compareVersions(v("22.10.0"), v("22.9.0"))).toBeGreaterThan(0);
    expect(compareVersions(v("22.9.1"), v("22.9.1"))).toBe(0);
  });
});

describe("parseRange / satisfies", () => {
  it("treats a bare major as the whole major line — the .nvmrc case from the report", () => {
    expect(matches("22", "22.0.0")).toBe(true);
    expect(matches("22", "22.20.1")).toBe(true);
    expect(matches("22", "24.15.0")).toBe(false);
    expect(matches("22", "21.9.9")).toBe(false);
  });

  it("accepts a leading v, as .nvmrc files often carry", () => {
    expect(matches("v22", "22.20.1")).toBe(true);
  });

  it("pins exactly when all three parts are given", () => {
    expect(matches("22.20.1", "22.20.1")).toBe(true);
    expect(matches("22.20.1", "22.20.2")).toBe(false);
  });

  it("narrows to a minor line for a two-part pin", () => {
    expect(matches("22.20", "22.20.7")).toBe(true);
    expect(matches("22.20", "22.21.0")).toBe(false);
  });

  it("handles x-ranges", () => {
    expect(matches("22.x", "22.20.1")).toBe(true);
    expect(matches("22.X", "23.0.0")).toBe(false);
    expect(matches("22.20.x", "22.20.9")).toBe(true);
    expect(matches("22.20.x", "22.21.0")).toBe(false);
  });

  it("handles the comparator forms engines.node uses", () => {
    expect(matches(">=20", "24.15.0")).toBe(true);
    expect(matches(">=20", "18.0.0")).toBe(false);
    expect(matches(">=20.5.0", "20.5.0")).toBe(true);
    expect(matches(">=20.5.0", "20.4.9")).toBe(false);
    expect(matches("<21", "20.19.0")).toBe(true);
    expect(matches("<21", "21.0.0")).toBe(false);
    expect(matches("<=22", "22.20.1")).toBe(true);
    expect(matches("<=22", "23.0.0")).toBe(false);
  });

  it("reads `>20` as after the whole 20 line, matching npm x-range semantics", () => {
    expect(matches(">20", "20.19.0")).toBe(false);
    expect(matches(">20", "21.0.0")).toBe(true);
    // With an explicit patch it is an ordinary strict comparison.
    expect(matches(">20.19.0", "20.19.0")).toBe(false);
    expect(matches(">20.19.0", "20.19.1")).toBe(true);
  });

  it("handles caret and tilde", () => {
    expect(matches("^22.0.0", "22.20.1")).toBe(true);
    expect(matches("^22.0.0", "23.0.0")).toBe(false);
    expect(matches("^22.5.0", "22.4.0")).toBe(false);
    expect(matches("~22.20.0", "22.20.9")).toBe(true);
    expect(matches("~22.20.0", "22.21.0")).toBe(false);
    expect(matches("~22", "22.9.9")).toBe(true);
    expect(matches("~22", "23.0.0")).toBe(false);
  });

  it("intersects space-separated comparators", () => {
    expect(matches(">=20 <23", "22.20.1")).toBe(true);
    expect(matches(">=20 <23", "23.0.0")).toBe(false);
    expect(matches(">=20 <23", "19.0.0")).toBe(false);
  });

  it("unions across ||", () => {
    expect(matches("^20 || ^22", "20.1.0")).toBe(true);
    expect(matches("^20 || ^22", "22.20.1")).toBe(true);
    expect(matches("^20 || ^22", "24.0.0")).toBe(false);
  });

  it("treats * and the empty string as any version", () => {
    expect(matches("*", "24.15.0")).toBe(true);
    expect(matches("", "24.15.0")).toBe(true);
  });

  it("returns null for forms it does not implement, rather than guessing", () => {
    // Aliases and hyphen ranges must surface as `unsupported` upstream — a
    // silently-wrong match would activate the wrong Node, which is worse than
    // reporting that we couldn't read the pin.
    expect(parseRange("lts/jod")).toBeNull();
    expect(parseRange("lts/*")).toBeNull();
    expect(parseRange("node")).toBeNull();
    expect(parseRange("stable")).toBeNull();
    expect(parseRange("18 - 22")).toBeNull();
    expect(parseRange("garbage!")).toBeNull();
  });
});

describe("pickBest", () => {
  const available = [v("18.20.4"), v("20.19.0"), v("22.20.1"), v("22.9.0"), v("24.15.0")];

  it("returns the newest satisfying version", () => {
    const spec = parseRange("22")!;
    expect(pickBest(available, spec)).toEqual(v("22.20.1"));
  });

  it("returns null when nothing satisfies", () => {
    const spec = parseRange("^19")!;
    expect(pickBest(available, spec)).toBeNull();
  });
});

describe("readNodePin", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-pin-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the repo pins nothing — the invisible common case", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(readNodePin(dir)).toBeNull();
  });

  it("reads .nvmrc", () => {
    fs.writeFileSync(path.join(dir, ".nvmrc"), "22\n");
    const pin = readNodePin(dir);
    expect(pin?.source).toBe(".nvmrc");
    expect(pin?.raw).toBe("22");
    expect(satisfies(v("22.20.1"), pin!.spec!)).toBe(true);
  });

  it("ignores comments and blank lines in .nvmrc", () => {
    fs.writeFileSync(path.join(dir, ".nvmrc"), "# the version CI uses\n\n  22.20.1  \n");
    expect(readNodePin(dir)?.raw).toBe("22.20.1");
  });

  it("reads engines.node when there is no .nvmrc", () => {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", engines: { node: ">=20" } }),
    );
    const pin = readNodePin(dir);
    expect(pin?.source).toBe("engines.node");
    expect(pin?.raw).toBe(">=20");
  });

  it("prefers .nvmrc over engines.node when both exist (requirement 3)", () => {
    fs.writeFileSync(path.join(dir, ".nvmrc"), "22");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ engines: { node: ">=20" } }),
    );
    expect(readNodePin(dir)?.source).toBe(".nvmrc");
  });

  it("reports an unsupported .nvmrc rather than falling through to engines.node", () => {
    // The repo did express a preference; honoring a different source silently
    // would be more surprising than saying we couldn't read this one.
    fs.writeFileSync(path.join(dir, ".nvmrc"), "lts/jod");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ engines: { node: ">=20" } }),
    );
    const pin = readNodePin(dir);
    expect(pin?.source).toBe(".nvmrc");
    expect(pin?.spec).toBeNull();
  });

  it("survives a malformed package.json", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{ not json");
    expect(readNodePin(dir)).toBeNull();
  });

  it("ignores a non-string or empty engines.node", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ engines: { node: 22 } }));
    expect(readNodePin(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ engines: { node: "  " } }));
    expect(readNodePin(dir)).toBeNull();
  });

  it("does NOT read the ecosystem pin files requirement 3 excludes", () => {
    fs.writeFileSync(path.join(dir, ".node-version"), "18");
    fs.writeFileSync(path.join(dir, ".tool-versions"), "nodejs 18.20.4");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ volta: { node: "18.20.4" } }),
    );
    expect(readNodePin(dir)).toBeNull();
  });
});
