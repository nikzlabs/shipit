/**
 * Regression tests for the shim flush-on-exit contract (`shim-exit.ts`).
 *
 * These MUST spawn a real subprocess with a real pipe on stdout: the bug is a
 * property of `process.exit()` racing Node's asynchronous pipe writes, so an
 * in-process test with a stubbed `ShimIO` cannot see it. Before the fix, output
 * larger than the 64 KiB Linux pipe buffer came back truncated at exactly 65,536
 * bytes — `shipit issue view --comments --json | wc -c` returned 65536 while the
 * same command redirected to a file returned the full document.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** Comfortably past the 64 KiB pipe buffer that used to swallow the tail. */
const BIG_CHARS = 300_000;

const tempDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * Run a TypeScript entry point under tsx with **piped** stdio (the failing
 * condition) and collect everything it wrote.
 */
function runPiped(
  entry: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [entry, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { stdout += c; });
    child.stderr.on("data", (c: string) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

/** Write a throwaway fixture module into a temp dir and return its path. */
async function writeFixture(source: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "shim-exit-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fixture.ts");
  await fsp.writeFile(file, source, "utf8");
  return file;
}

/** Absolute import specifier for a sibling shim module, `.js` as ESM requires. */
function shimModule(name: string): string {
  return path.join(HERE, `${name}.js`);
}

describe("shim stdout flushing", () => {
  it("delivers output larger than the 64 KiB pipe buffer intact when piped", { timeout: 60_000 }, async () => {
    const fixture = await writeFixture(`
      import { defaultIO } from ${JSON.stringify(shimModule("shim-common"))};
      defaultIO.stdout("x".repeat(${BIG_CHARS}) + "\\n");
      defaultIO.exit(0);
    `);

    const { stdout, code } = await runPiped(fixture, []);

    expect(stdout.length).toBe(BIG_CHARS + 1);
    expect(code).toBe(0);
  });

  it("preserves a non-zero exit code while flushing a large document", { timeout: 60_000 }, async () => {
    const fixture = await writeFixture(`
      import { defaultIO, fail } from ${JSON.stringify(shimModule("shim-common"))};
      defaultIO.stdout("y".repeat(${BIG_CHARS}));
      try { fail(defaultIO, "boom", 3); } catch { /* __shim_exit__ */ }
    `);

    const { stdout, stderr, code } = await runPiped(fixture, []);

    expect(stdout.length).toBe(BIG_CHARS);
    expect(stderr).toContain("boom");
    expect(code).toBe(3);
  });

  it("writes the same bytes to a pipe as to a file", { timeout: 60_000 }, async () => {
    const fixture = await writeFixture(`
      import { defaultIO } from ${JSON.stringify(shimModule("shim-common"))};
      defaultIO.stdout(JSON.stringify({ description: "z".repeat(${BIG_CHARS}) }));
      defaultIO.exit(0);
    `);

    const { stdout } = await runPiped(fixture, []);
    const outFile = path.join(path.dirname(fixture), "out.json");
    await new Promise<void>((resolve, reject) => {
      const fd = fs.openSync(outFile, "w");
      const child = spawn(TSX, [fixture], { cwd: REPO_ROOT, stdio: ["ignore", fd, "inherit"] });
      child.on("error", reject);
      child.on("close", () => { fs.closeSync(fd); resolve(); });
    });

    expect(stdout).toBe(await fsp.readFile(outFile, "utf8"));
    expect(JSON.parse(stdout).description.length).toBe(BIG_CHARS);
  });
});

describe("shipit issue view --json over a pipe", () => {
  /**
   * The reported repro, end-to-end through the real `shipit` entry point: a
   * brokered issue whose rendered JSON is well past 64 KiB must still parse on
   * the other side of a pipe.
   */
  it("returns a complete, parseable document for a large issue", { timeout: 60_000 }, async () => {
    const description = "d".repeat(BIG_CHARS);
    const server = http.createServer((req, res) => {
      const url = req.url ?? "";
      res.setHeader("Content-Type", "application/json");
      if (url.startsWith("/agent-ops/issue/trackers")) {
        res.end(
          JSON.stringify({
            destinations: [{ id: "linear:SHI", name: "roadmap", key: "SHI", kind: "linear" }],
          }),
        );
        return;
      }
      if (url.startsWith("/agent-ops/issue/view")) {
        res.end(
          JSON.stringify({
            issue: {
              id: "uuid-1",
              identifier: "roadmap#SHI-56",
              title: "Big issue",
              url: "https://linear.app/x/issue/SHI-56",
              description,
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const { stdout, stderr, code } = await runPiped(
      path.join(HERE, "shipit.ts"),
      ["issue", "view", "roadmap#SHI-56", "--json"],
      { SHIPIT_AGENT_OPS_URL: `http://127.0.0.1:${port}` },
    );

    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { description: string };
    expect(parsed.description.length).toBe(BIG_CHARS);
  });
});
