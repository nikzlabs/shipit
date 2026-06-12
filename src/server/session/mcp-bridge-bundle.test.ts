import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * docs/199 — contract test for the precompiled MCP bridge bundles.
 *
 * The fix for the 0.5-CPU agent-default failure is that each bridge ships as a
 * self-contained plain-JS bundle run with `node` (no per-spawn tsx compile, no
 * runtime node_modules resolution). This test asserts that property end-to-end:
 * it bundles the permission bridge with the same esbuild options as
 * scripts/build-mcp-bridges.mjs, runs the output with `node` from a directory
 * that has NO node_modules, and drives the MCP handshake to confirm the
 * `permission_prompt` tool registers. A bridge that gained a non-bundleable
 * dependency, or that relied on a runtime `require` the banner doesn't cover,
 * would fail here instead of silently falling over in production.
 *
 * Mirrors the esbuild config in scripts/build-mcp-bridges.mjs — keep them in sync.
 */
const sessionDir = path.dirname(fileURLToPath(import.meta.url));

async function bundleBridge(basename: string, outdir: string): Promise<string> {
  await build({
    entryPoints: [path.join(sessionDir, `${basename}.ts`)],
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);",
    },
    logLevel: "silent",
  });
  return path.join(outdir, `${basename}.js`);
}

/** Spawn the bundle with node and run an MCP initialize + tools/list handshake. */
function handshake(bundlePath: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [bundlePath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: { ...process.env, WORKER_PORT: "9999" },
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes('"id":2')) {
        proc.kill();
        resolve(out);
      }
    });
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", reject);
    const msgs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    for (const m of msgs) proc.stdin.write(`${JSON.stringify(m)}\n`);
    setTimeout(() => {
      proc.kill();
      reject(new Error(`bridge did not answer tools/list in time. stderr: ${err.slice(0, 500)}`));
    }, 10_000);
  });
}

describe("precompiled MCP bridge bundle (docs/199)", () => {
  it("runs the permission bridge under node with no node_modules and registers its tool", async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-build-"));
    // Run dir is a separate temp dir with no node_modules — proves the bundle is
    // self-contained (the @modelcontextprotocol/sdk is inlined).
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-run-"));
    try {
      const built = await bundleBridge("mcp-permission-bridge", buildDir);
      const bundle = path.join(runDir, "mcp-permission-bridge.js");
      fs.copyFileSync(built, bundle);

      const out = await handshake(bundle, runDir);
      expect(out).toContain("shipit-permission");
      expect(out).toContain("permission_prompt");
    } finally {
      fs.rmSync(buildDir, { recursive: true, force: true });
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  }, 20_000);
});
