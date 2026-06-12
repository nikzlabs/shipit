import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBridge } from "./mcp-bridge-paths.js";

/**
 * docs/199 — resolveBridge prefers the precompiled plain-JS bundle (run with
 * `node`) over the `.ts` source (run with `tsx`), so a session at the 0.5-CPU
 * AGENT_DEFAULTS no longer pays the per-spawn tsx compile that made the
 * permission bridge miss the Claude CLI's 2000ms MCP pre-wait. Falls back to tsx
 * source when no bundle is present (dev/local images), and to null when neither
 * exists (stripped-down test image).
 */
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
    // Fake interpreter binaries so the existsSync gate passes.
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

  it("resolves the consolidated bridge basename the worker registers (SHI-128)", () => {
    const name = "mcp-shipit-bridge";
    fs.writeFileSync(path.join(compiledDir, `${name}.js`), "//");
    const resolved = resolveBridge(name, dirs());
    expect(resolved?.bridgePath).toBe(path.join(compiledDir, `${name}.js`));
    expect(resolved?.tsxBin).toBe(nodeBin);
  });
});
