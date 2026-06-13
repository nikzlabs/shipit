import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * docs/199 — contract test for the precompiled MCP bridge bundle.
 *
 * The fix for the 0.5-CPU agent-default failure is that the bridge ships as a
 * self-contained plain-JS bundle run with `node` (no per-spawn tsx compile, no
 * runtime node_modules resolution). SHI-128 then consolidated the five per-tool
 * bridges into ONE `mcp-shipit-bridge` server whose exposed tools are chosen via
 * the `SHIPIT_MCP_TOOLS` env. This test asserts both properties end-to-end: it
 * bundles `mcp-shipit-bridge` (which pulls in every `mcp-tools/*` module) with
 * the same esbuild options as scripts/build-mcp-bridges.mjs, runs the output
 * with `node` from a directory that has NO node_modules, and drives the MCP
 * handshake to confirm the selected tools register under the `shipit` server. A
 * tool module that gained a non-bundleable dependency, or relied on a runtime
 * `require` the banner doesn't cover, would fail here instead of silently
 * falling over in production.
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
function handshake(bundlePath: string, cwd: string, tools: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [bundlePath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: { ...process.env, WORKER_PORT: "9999", SHIPIT_MCP_TOOLS: tools },
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

describe("precompiled MCP bridge bundle (docs/199, SHI-128)", () => {
  it("runs the consolidated bridge under node with no node_modules and registers the selected tools", async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-build-"));
    // Run dir is a separate temp dir with no node_modules — proves the bundle is
    // self-contained (the @modelcontextprotocol/sdk is inlined).
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-run-"));
    try {
      const built = await bundleBridge("mcp-shipit-bridge", buildDir);
      const bundle = path.join(runDir, "mcp-shipit-bridge.js");
      fs.copyFileSync(built, bundle);

      // Claude's tool subset — exercises every tool module in the bundle.
      const out = await handshake(bundle, runDir, "review,present,voice,bug,permission");
      // Single `shipit` server (from initialize serverInfo), all five tools listed.
      expect(out).toContain("shipit");
      expect(out).toContain("submit_review");
      expect(out).toContain("present");
      expect(out).toContain("voice_note");
      expect(out).toContain("report_shipit_bug");
      expect(out).toContain("permission_prompt");
      // `ask` was NOT selected, so no tool is registered under that name. (Match
      // the JSON tool-name key, not bare "AskUserQuestion" — the voice tool's
      // description mentions it in prose.)
      expect(out).not.toContain('"name":"AskUserQuestion"');
    } finally {
      fs.rmSync(buildDir, { recursive: true, force: true });
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  }, 20_000);
});
