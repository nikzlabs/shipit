import { readFileSync } from "node:fs";
import {
  collectDescendants,
  killDescendantTree,
  type ProcessIdentity,
} from "../../shared/kill-child.js";

/**
 * A page the agent has stopped looking at keeps rendering for the container's lifetime.
 * A WebGL page is the expensive case: headless Chromium rasterizes it in SwiftShader
 * across a worker per visible core, which is the host's core count and not the
 * container's quota, so one abandoned game page consumes the whole quota for hours.
 * See docs/315-browser-cpu-between-turns; docs/289 covers the browser outliving the
 * agent CLI, which is a different moment and leaves this one uncovered.
 */

/** Playwright launch flag, carried by the top browser process and by nothing under it. */
const BROWSER_ROOT_FLAG = "--remote-debugging-pipe";
const MCP_SERVER_MARKER = "playwright-mcp";

const SAMPLE_MS = 1_000;
/**
 * Clock ticks per second above which a tree counts as still rendering; 100 is one core.
 * Measured in a session container: `about:blank` 0, a real static page 3, a canvas
 * animation ~6, the WebGL page that pegged production 587. A static page and a light
 * animation are only 2 apart, so no threshold separates them — and neither needs to be,
 * since both cost a few percent of a core. 25 sits an order of magnitude below the case
 * worth reclaiming and well clear of a settled page, which req 2 promises to keep.
 */
const BUSY_TICKS_PER_SEC = 25;

function readCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, "utf-8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}

function readPpid(pid: number): number | null {
  try {
    const raw = readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    const close = raw.lastIndexOf(")");
    if (close === -1) return null;
    const ppid = Number.parseInt(raw.slice(close + 2).split(" ")[1] ?? "", 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/** Fields 14 and 15 of /proc/<pid>/stat: utime + stime, in clock ticks. */
function readTicks(pid: number): number {
  try {
    const raw = readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    const close = raw.lastIndexOf(")");
    if (close === -1) return 0;
    const fields = raw.slice(close + 2).split(" ");
    const utime = Number.parseInt(fields[11] ?? "", 10);
    const stime = Number.parseInt(fields[12] ?? "", 10);
    return (Number.isFinite(utime) ? utime : 0) + (Number.isFinite(stime) ? stime : 0);
  } catch {
    return 0;
  }
}

/** Re-walked per sample: the renderer and GPU processes come and go under the root. */
function readTreeTicks(root: number): number {
  let total = readTicks(root);
  for (const descendant of collectDescendants(root)) total += readTicks(descendant.pid);
  return total;
}

/**
 * Browsers this worker's agent opened through the built-in Playwright MCP server, found
 * by walking down from ourselves. A browser the user's own project launched has a test
 * runner for a parent rather than the MCP server, and is not ours to touch.
 */
export function findManagedBrowsers(): ProcessIdentity[] {
  const found: ProcessIdentity[] = [];
  for (const candidate of collectDescendants(process.pid)) {
    if (!readCmdline(candidate.pid).includes(BROWSER_ROOT_FLAG)) continue;
    const ppid = readPpid(candidate.pid);
    if (ppid === null || !readCmdline(ppid).includes(MCP_SERVER_MARKER)) continue;
    found.push(candidate);
  }
  return found;
}

export interface ReclaimOptions {
  /**
   * Re-checked after the sample and immediately before each kill. A turn that started
   * while we measured owns the browser again, and cancels the reclaim.
   */
  stillIdle: () => boolean;
  sampleMs?: number;
  busyTicksPerSec?: number;
}

/**
 * Kills the browser rather than closing its page: `playwright-mcp` exposes no way in
 * from outside, launches lazily, so the next tool call gets a fresh one. The cost is the
 * in-memory `--isolated` profile, cookies and logins included (requirements req 3).
 */
export async function reclaimStillRenderingBrowsers(opts: ReclaimOptions): Promise<number> {
  const sampleMs = opts.sampleMs ?? SAMPLE_MS;
  const busy = opts.busyTicksPerSec ?? BUSY_TICKS_PER_SEC;

  const roots = findManagedBrowsers();
  if (roots.length === 0) return 0;

  const before = roots.map((root) => ({ root, ticks: readTreeTicks(root.pid) }));
  await new Promise((resolve) => setTimeout(resolve, sampleMs));

  let reclaimed = 0;
  for (const { root, ticks } of before) {
    const rate = ((readTreeTicks(root.pid) - ticks) * 1000) / sampleMs;
    if (rate < busy) {
      console.log(`[browser-reclaim] pid=${String(root.pid)} settled (${rate.toFixed(1)} ticks/s) — keeping it`);
      continue;
    }
    if (!opts.stillIdle()) {
      console.log(`[browser-reclaim] pid=${String(root.pid)} busy, but a turn started — leaving it alone`);
      continue;
    }
    console.log(`[browser-reclaim] pid=${String(root.pid)} still rendering (${rate.toFixed(1)} ticks/s) — reclaiming`);
    if (killDescendantTree(root, "SIGTERM", { label: "idle-browser" })) reclaimed++;
  }
  return reclaimed;
}
