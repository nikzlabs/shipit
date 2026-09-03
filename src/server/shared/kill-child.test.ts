import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { collectDescendants, killChild, killProcessTree } from "./kill-child.js";

describe("killChild", () => {
  it("no-ops on null/undefined", () => {
    expect(killChild(null)).toBe(false);
    expect(killChild(undefined)).toBe(false);
  });

  /**
   * The whole point of the helper. `ChildProcess.kill()` on a spawn that never
   * exec'd still reaches `uv_process_kill`, which passes the handle's
   * uninitialized `pid` to `kill(2)` — signalling an arbitrary unrelated
   * process while returning `false` as if nothing happened.
   */
  it("does not call kill() on a child whose spawn failed", async () => {
    const proc = spawn("definitely-not-a-real-binary-xyzzy", ["--nope"]);
    const err = await new Promise<Error>((resolve) => proc.once("error", resolve));
    expect(err.message).toContain("ENOENT");
    expect(proc.pid).toBeUndefined();

    const killSpy = vi.spyOn(proc, "kill");
    expect(killChild(proc, "SIGKILL")).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("kills a child that really spawned", async () => {
    const proc = spawn("sleep", ["30"]);
    await new Promise<void>((resolve) => proc.once("spawn", resolve));
    expect(typeof proc.pid).toBe("number");

    expect(killChild(proc, "SIGKILL")).toBe(true);
    const code = await new Promise<number | null>((resolve) =>
      proc.once("close", (c, signal) => resolve(c ?? (signal ? -1 : null))),
    );
    expect(code).not.toBeNull();
  });

  it("swallows a throw from kill() rather than propagating it", () => {
    const fake = {
      pid: 12345,
      kill: () => { throw new Error("ESRCH"); },
    } as unknown as ChildProcess;
    expect(killChild(fake)).toBe(false);
  });
});

/**
 * True while `pid` names a live process. A zombie reads as dead: this container
 * has no reaping init, so a killed orphan's entry lingers in `/proc` forever and
 * a mere `existsSync` would never go false.
 */
function alive(pid: number): boolean {
  try {
    const raw = readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

/** Poll `predicate` every 25ms until it holds or `timeoutMs` elapses. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

// `/proc` is the only descendant source, so these are Linux-only — which is the
// whole production runtime. A macOS dev machine skips them; CI does not.
describe.skipIf(!existsSync("/proc/1/stat"))("killProcessTree", () => {
  const strays: number[] = [];
  afterEach(() => {
    for (const pid of strays.splice(0)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  /** Spawn `sh -c <script>` and resolve once it has `count` descendants. */
  async function spawnTree(script: string, count: number): Promise<ChildProcess> {
    const proc = spawn("sh", ["-c", script]);
    await new Promise<void>((resolve) => proc.once("spawn", resolve));
    const pid = proc.pid;
    if (pid === undefined) throw new Error("spawn produced no pid");
    strays.push(pid);
    const appeared = await until(() => collectDescendants(pid).length >= count);
    expect(appeared).toBe(true);
    for (const d of collectDescendants(pid)) strays.push(d.pid);
    return proc;
  }

  it("keeps the killChild guarantee on a spawn that never exec'd", async () => {
    const proc = spawn("definitely-not-a-real-binary-xyzzy", ["--nope"]);
    await new Promise<Error>((resolve) => proc.once("error", resolve));
    const killSpy = vi.spyOn(proc, "kill");
    expect(killProcessTree(proc, "SIGTERM")).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });

  /**
   * The defect in one test. `sh -c 'sleep 300 & sleep 300'` leaves two sleeps
   * that are NOT killed by the death of their parent — the same shape as an
   * agent CLI's MCP server leaving a Playwright browser behind. The first half
   * shows the pre-fix behaviour (a plain `killChild` orphans them), the second
   * that the tree kill collects them.
   */
  it("kills descendants that outlive a plain killChild", async () => {
    const orphaning = await spawnTree("sleep 300 & sleep 300", 2);
    const orphaned = collectDescendants(orphaning.pid ?? 0);
    expect(orphaned.length).toBeGreaterThanOrEqual(2);

    killChild(orphaning, "SIGTERM");
    // `exit`, not `close`: the orphans inherited stdout, so the pipe — and
    // therefore `close` — stays open for as long as they do. That delayed
    // `close` is the second symptom of the same leak.
    await new Promise<void>((resolve) => orphaning.once("exit", () => resolve()));
    // The parent is gone and its children are not — this is the leak.
    expect(orphaned.every((d) => alive(d.pid))).toBe(true);
    for (const d of orphaned) process.kill(d.pid, "SIGKILL");

    const proc = await spawnTree("sleep 300 & sleep 300", 2);
    const descendants = collectDescendants(proc.pid ?? 0);
    expect(descendants.length).toBeGreaterThanOrEqual(2);

    killProcessTree(proc, "SIGTERM", { graceMs: 200 });
    expect(await until(() => descendants.every((d) => !alive(d.pid)))).toBe(true);
  });

  /**
   * SIGTERM is a request. A tree that declines it (`trap "" TERM`, which an
   * exec inherits as SIG_IGN) must still be gone after the grace — including
   * the root, which is on the sweep roster alongside its descendants.
   */
  it("SIGKILLs what survives the grace period, root included", async () => {
    const proc = await spawnTree('trap "" TERM; sleep 300 & sleep 300', 2);
    const rootPid = proc.pid ?? 0;
    const descendants = collectDescendants(rootPid);

    killProcessTree(proc, "SIGTERM", { graceMs: 100 });
    // Still there right after the SIGTERM: it was ignored.
    expect(alive(rootPid)).toBe(true);

    expect(await until(() => descendants.every((d) => !alive(d.pid)))).toBe(true);
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) resolve();
      else proc.once("exit", () => resolve());
    });
    expect(proc.signalCode).toBe("SIGKILL");
  });

  /**
   * The trust boundary. Once a signal leaves the `ChildProcess` object it is a
   * raw `process.kill(pid)` that no fake intercepts, so a caller handing over a
   * pid it did not spawn — which is every adapter test's fabricated `pid: 4242`
   * — must not get a tree torn down on its behalf.
   */
  it("refuses to walk a tree whose root is not our own child", async () => {
    const outer = await spawnTree("sh -c 'sleep 300 & sleep 300' & sleep 300", 3);
    const grandchild = collectDescendants(outer.pid ?? 0)
      .map((d) => d.pid)
      .find((pid) => collectDescendants(pid).length >= 2);
    expect(grandchild).toBeDefined();
    const notOurs = grandchild ?? 0;
    const itsChildren = collectDescendants(notOurs);

    const kill = vi.fn(() => true);
    const impostor = { pid: notOurs, kill } as unknown as ChildProcess;
    expect(killProcessTree(impostor, "SIGTERM", { graceMs: 50 })).toBe(true);

    // The root got its signal through the ChildProcess (here, the fake) and its
    // children were left entirely alone — no walk, no sweep.
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    expect(itsChildren.every((d) => alive(d.pid))).toBe(true);
  });

  it("reports the whole chain, not just direct children", async () => {
    const proc = await spawnTree("sh -c 'sleep 300 & sleep 300' & sleep 300", 3);
    const pids = collectDescendants(proc.pid ?? 0).map((d) => d.pid);
    // A grandchild is present only if the walk recurses.
    expect(pids.length).toBeGreaterThanOrEqual(3);
    expect(pids).not.toContain(proc.pid);

    killProcessTree(proc, "SIGTERM", { graceMs: 200 });
    expect(await until(() => pids.every((pid) => !alive(pid)))).toBe(true);
  });
});
