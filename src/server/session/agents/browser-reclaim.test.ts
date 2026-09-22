import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findManagedBrowsers, reclaimStillRenderingBrowsers } from "./browser-reclaim.js";

// Real trees rather than fakes: the module's whole job is reading /proc correctly.
const spawned: ChildProcess[] = [];
let dir = "";

const BUSY = "const e=Date.now()+60000;while(Date.now()<e){Math.sqrt(Math.random());}";
const IDLE = "setInterval(()=>{},1e9);";

// The parent's marker rides in its script PATH and the child's in an argv flag, because
// node parses a `--flag` after `-e` as its own option and refuses to start.
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "browser-reclaim-"));
  writeFileSync(path.join(dir, "busy.cjs"), BUSY);
  writeFileSync(path.join(dir, "idle.cjs"), IDLE);
  const launcher = (child: string) =>
    `require("node:child_process").spawn(process.execPath,`
    + `[${JSON.stringify(path.join(dir, child))},"--remote-debugging-pipe"],{stdio:"ignore"});${IDLE}`;
  writeFileSync(path.join(dir, "playwright-mcp-busy.cjs"), launcher("busy.cjs"));
  writeFileSync(path.join(dir, "playwright-mcp-idle.cjs"), launcher("idle.cjs"));
  writeFileSync(path.join(dir, "project-test-runner.cjs"), launcher("idle.cjs"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function spawnFixture(script: string): ChildProcess {
  const proc = spawn(process.execPath, [path.join(dir, script)], { stdio: "ignore" });
  spawned.push(proc);
  return proc;
}

/** A stand-in for `playwright-mcp` spawning Chromium: the markers are what we match on. */
function spawnFakeMcpWithBrowser(busy: boolean): ChildProcess {
  return spawnFixture(busy ? "playwright-mcp-busy.cjs" : "playwright-mcp-idle.cjs");
}

function spawnUnmanagedBrowser(): ChildProcess {
  return spawnFixture("project-test-runner.cjs");
}

function alive(pid: number): boolean {
  return existsSync(`/proc/${String(pid)}`);
}

async function waitForBrowser(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const found = findManagedBrowsers();
    if (found.length > 0) return found[0]!.pid;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("fixture browser never appeared");
}

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  // Grandchildren are orphaned by the kill above; sweep them by marker.
  for (const found of findManagedBrowsers()) {
    try { process.kill(found.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  await new Promise((r) => setTimeout(r, 50));
});

describe("findManagedBrowsers", () => {
  it("finds a browser whose parent is the Playwright MCP server", async () => {
    spawnFakeMcpWithBrowser(false);
    const pid = await waitForBrowser();
    expect(alive(pid)).toBe(true);
  });

  it("ignores a browser the project launched itself", async () => {
    spawnUnmanagedBrowser();
    await new Promise((r) => setTimeout(r, 500));
    expect(findManagedBrowsers()).toEqual([]);
  });
});

describe("reclaimStillRenderingBrowsers", () => {
  it("reclaims a browser that is still rendering", async () => {
    spawnFakeMcpWithBrowser(true);
    const pid = await waitForBrowser();

    const reclaimed = await reclaimStillRenderingBrowsers({
      stillIdle: () => true,
      sampleMs: 300,
    });

    expect(reclaimed).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
  });

  it("leaves a browser on a settled page alone", async () => {
    spawnFakeMcpWithBrowser(false);
    const pid = await waitForBrowser();

    const reclaimed = await reclaimStillRenderingBrowsers({
      stillIdle: () => true,
      sampleMs: 300,
    });

    expect(reclaimed).toBe(0);
    expect(alive(pid)).toBe(true);
  });

  it("does not reclaim when a turn started while it sampled", async () => {
    spawnFakeMcpWithBrowser(true);
    const pid = await waitForBrowser();

    const reclaimed = await reclaimStillRenderingBrowsers({
      stillIdle: () => false,
      sampleMs: 300,
    });

    expect(reclaimed).toBe(0);
    expect(alive(pid)).toBe(true);
  });

  it("reports nothing to do when no browser is open", async () => {
    expect(await reclaimStillRenderingBrowsers({ stillIdle: () => true, sampleMs: 50 })).toBe(0);
  });
});
