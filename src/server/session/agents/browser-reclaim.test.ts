import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { killProcessTree } from "../../shared/kill-child.js";
import {
  findManagedBrowsers,
  reclaimStillRenderingBrowsers,
  ticksBurned,
} from "./browser-reclaim.js";

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

// Snapshot before signalling, per docs/289: killing a fixture parent first orphans its
// browser onto pid 1, where it is neither our descendant nor a child of anything named
// `playwright-mcp` — so nothing can find it again, and a busy one burns a core for the
// rest of its minute. `killProcessTree` takes the whole tree in one go.
afterEach(async () => {
  for (const child of spawned.splice(0)) {
    killProcessTree(child, "SIGKILL", { label: "reclaim-fixture", graceMs: 0 });
  }
  await new Promise((r) => setTimeout(r, 100));
  const survivors = findManagedBrowsers();
  expect(survivors, "fixture browsers outlived the test").toEqual([]);
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

  // Idle flips DURING the sample, so an implementation that only checked before sampling
  // would still kill and fail here. The paired assertion above — same fixture, same
  // sample window, reclaimed — is what rules out passing because nothing looked busy.
  it("does not reclaim when a turn starts while it samples", async () => {
    spawnFakeMcpWithBrowser(true);
    const pid = await waitForBrowser();

    let idle = true;
    setTimeout(() => { idle = false; }, 100);
    const reclaimed = await reclaimStillRenderingBrowsers({
      stillIdle: () => idle,
      sampleMs: 300,
    });

    expect(idle).toBe(false);
    expect(reclaimed).toBe(0);
    expect(alive(pid)).toBe(true);
  });

  it("reports nothing to do when no browser is open", async () => {
    expect(await reclaimStillRenderingBrowsers({ stillIdle: () => true, sampleMs: 50 })).toBe(0);
  });
});

// The population changes between samples, so a difference of totals is not the CPU burned.
describe("ticksBurned", () => {
  const p = (startTime: number, ticks: number) => ({ startTime, ticks });

  it("counts the delta for a process present in both samples", () => {
    expect(ticksBurned(new Map([[10, p(1, 500)]]), new Map([[10, p(1, 560)]]))).toBe(60);
  });

  it("counts all of a process that appeared, which can only have run inside the window", () => {
    expect(ticksBurned(new Map(), new Map([[11, p(2, 30)]]))).toBe(30);
  });

  it("is not dragged negative by a long-lived process that exited", () => {
    // The real shape: a GPU process with hours on it exits while a sibling keeps working.
    const before = new Map([[10, p(1, 10_000)], [11, p(2, 100)]]);
    const after = new Map([[11, p(2, 600)]]);
    expect(ticksBurned(before, after)).toBe(500);
  });

  it("treats a reused pid as a new process rather than crediting its predecessor", () => {
    const before = new Map([[10, p(1, 900)]]);
    const after = new Map([[10, p(7, 40)]]);
    expect(ticksBurned(before, after)).toBe(40);
  });
});
