import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sessionDir = path.dirname(fileURLToPath(import.meta.url));

async function bundleBridge(basename: string, outdir: string): Promise<string> {
  // Keep these options in sync with scripts/build-mcp-bridges.mjs.
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

describe("precompiled MCP bridge bundle (docs/199, planning#130)", () => {
  it("runs the consolidated bridge under node with no node_modules and registers the selected tools", async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-build-"));
    // A separate directory without node_modules proves the bundle is self-contained.
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-run-"));
    try {
      const built = await bundleBridge("mcp-shipit-bridge", buildDir);
      const bundle = path.join(runDir, "mcp-shipit-bridge.js");
      fs.copyFileSync(built, bundle);

      const out = await handshake(bundle, runDir, "present,voice,bug,permission");
      expect(out).toContain("shipit");
      expect(out).toContain("present");
      expect(out).toContain("voice_note");
      expect(out).toContain("report_shipit_bug");
      expect(out).toContain("permission_prompt");
      // Match the name key: another tool's description mentions AskUserQuestion.
      expect(out).not.toContain('"name":"AskUserQuestion"');
    } finally {
      fs.rmSync(buildDir, { recursive: true, force: true });
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  }, 20_000);
});
