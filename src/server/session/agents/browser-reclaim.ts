import { readFileSync } from "node:fs";
import {
  collectDescendants,
  killDescendantTree,
  type ProcessIdentity,
} from "../../shared/kill-child.js";
import { PLAYWRIGHT_MCP_BIN } from "./playwright-mcp.js";

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
function sampleTree(root: ProcessIdentity): Map<number, { startTime: number; ticks: number }> {
  const sample = new Map<number, { startTime: number; ticks: number }>();
  sample.set(root.pid, { startTime: root.startTime, ticks: readTicks(root.pid) });
  for (const d of collectDescendants(root.pid)) {
    sample.set(d.pid, { startTime: d.startTime, ticks: readTicks(d.pid) });
  }
  return sample;
}

/**
 * Per-process deltas, never a difference of totals. A tree's population changes between
 * samples, and a process that exits takes its whole LIFETIME tick count out of the second
 * total — a departing GPU process with hours on it swamps the CPU its siblings burned
 * during the window, so a busy tree reads as settled. A process present in both samples
 * contributes its delta; one that appeared contributes all of its ticks, which it can
 * only have accrued inside the window. One that vanished contributes nothing, because
 * nothing here can say how much of its lifetime fell inside the window — that undercounts
 * and so errs toward keeping a browser, never toward killing a live one.
 */
export function ticksBurned(
  before: Map<number, { startTime: number; ticks: number }>,
  after: Map<number, { startTime: number; ticks: number }>,
): number {
  let burned = 0;
  for (const [pid, now] of after) {
    const then = before.get(pid);
    burned += then?.startTime === now.startTime ? now.ticks - then.ticks : now.ticks;
  }
  return burned;
}

/**
 * Browsers this worker's agent opened through the built-in Playwright MCP server, found
 * by walking down from ourselves. A browser the user's own project launched has a test
 * runner for a parent rather than the MCP server, and is not ours to touch.
 *
 * Matched on the binary name we exec, so the two move together — but it is a substring
 * of a command line, not proof of identity: a project runner invoked through a path that
 * happens to contain the name would match. A browser already orphaned onto pid 1 is
 * invisible to the walk, and stays docs/289's problem rather than this one's.
 */
export function findManagedBrowsers(): ProcessIdentity[] {
  const found: ProcessIdentity[] = [];
  for (const candidate of collectDescendants(process.pid)) {
    if (!readCmdline(candidate.pid).includes(BROWSER_ROOT_FLAG)) continue;
    const ppid = readPpid(candidate.pid);
    if (ppid === null || !readCmdline(ppid).includes(PLAYWRIGHT_MCP_BIN)) continue;
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

  const before = roots.map((root) => ({ root, sample: sampleTree(root) }));
  const startedAt = performance.now();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  // Real elapsed time, not the requested delay: a timer that fires late under load would
  // otherwise inflate the rate and reclaim a page that is barely moving.
  const elapsedMs = Math.max(performance.now() - startedAt, 1);

  let reclaimed = 0;
  for (const { root, sample } of before) {
    const rate = (ticksBurned(sample, sampleTree(root)) * 1000) / elapsedMs;
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
