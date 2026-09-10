import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBridge } from "./mcp-bridge-paths.js";

describe("resolveBridge (docs/199)", () => {
  let tmp: string;
  let compiledDir: string;
  let sourceDir: string;
  let nodeBin: string;
  let tsxBin: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-bridge-paths-"));
    compiledDir = path.join(tmp, "dist", "mcp-bridges");
    sourceDir = path.join(tmp, "src", "session");
    fs.mkdirSync(compiledDir, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    nodeBin = path.join(tmp, "node");
    tsxBin = path.join(tmp, "tsx");
    fs.writeFileSync(nodeBin, "#!/bin/sh\n");
    fs.writeFileSync(tsxBin, "#!/bin/sh\n");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const dirs = () => ({ compiledDir, sourceDir, nodeBin, tsxBin });

  it("prefers the precompiled JS bundle, launched with node", () => {
    fs.writeFileSync(path.join(compiledDir, "mcp-shipit-bridge.js"), "//");
    fs.writeFileSync(path.join(sourceDir, "mcp-shipit-bridge.ts"), "//");

    expect(resolveBridge("mcp-shipit-bridge", dirs())).toEqual({
      tsxBin: nodeBin,
      bridgePath: path.join(compiledDir, "mcp-shipit-bridge.js"),
    });
  });

  it("falls back to the .ts source via tsx when no bundle exists", () => {
    fs.writeFileSync(path.join(sourceDir, "mcp-shipit-bridge.ts"), "//");

    expect(resolveBridge("mcp-shipit-bridge", dirs())).toEqual({
      tsxBin,
      bridgePath: path.join(sourceDir, "mcp-shipit-bridge.ts"),
    });
  });

  it("returns null when neither bundle nor source is present", () => {
    expect(resolveBridge("mcp-shipit-bridge", dirs())).toBeNull();
  });

  it("returns null when source exists but the tsx binary is missing", () => {
    fs.writeFileSync(path.join(sourceDir, "mcp-shipit-bridge.ts"), "//");
    fs.rmSync(tsxBin);

    expect(resolveBridge("mcp-shipit-bridge", dirs())).toBeNull();
  });

  it("resolves the consolidated bridge basename the worker registers (planning#130)", () => {
    const name = "mcp-shipit-bridge";
    fs.writeFileSync(path.join(compiledDir, `${name}.js`), "//");
    const resolved = resolveBridge(name, dirs());
    expect(resolved?.bridgePath).toBe(path.join(compiledDir, `${name}.js`));
    expect(resolved?.tsxBin).toBe(nodeBin);
  });
});
