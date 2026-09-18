import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { collectDescendants, killChild, killProcessTree, type ProcessIdentity } from "./kill-child.js";

describe("killChild", () => {
  it("no-ops on null/undefined", () => {
    expect(killChild(null)).toBe(false);
    expect(killChild(undefined)).toBe(false);
  });

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

// Without a reaping init, a dead process can keep its /proc entry.
function alive(pid: number): boolean {
  try {
    const raw = readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

async function until(predicate: () => boolean, timeoutMs = 5_000, everyMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return predicate();
}

describe.skipIf(!existsSync("/proc/1/stat"))("killProcessTree", () => {
  const strays: number[] = [];
  afterEach(() => {
    for (const pid of strays.splice(0)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  async function spawnTree(script: string, count: number): Promise<ChildProcess> {
    const proc = spawn("sh", ["-c", script]);
    await new Promise<void>((resolve) => proc.once("spawn", resolve));
    const pid = proc.pid;
    if (pid === undefined) throw new Error("spawn produced no pid");
    strays.push(pid);
    // Use a slower interval for full process-table scans.
    const appeared = await until(() => collectDescendants(pid).length >= count, 5_000, 100);
    expect(appeared).toBe(true);
    for (const d of collectDescendants(pid)) strays.push(d.pid);
    return proc;
  }

  it("refuses to walk a tree behind a handle that has already exited", async () => {
    const proc = await spawnTree("sleep 300 & sleep 300", 2);
    const descendants = collectDescendants(proc.pid ?? 0);
    expect(descendants.length).toBeGreaterThanOrEqual(2);

    // Simulate a stale handle whose pid now belongs to another live child.
    const kill = vi.fn(() => true);
    const stale = { pid: proc.pid, kill, exitCode: 0, signalCode: null } as unknown as ChildProcess;
    killProcessTree(stale, "SIGTERM", { graceMs: 50 });

    await new Promise((r) => setTimeout(r, 300));
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(descendants.every((d) => alive(d.pid))).toBe(true);
  });

  it("keeps the killChild guarantee on a spawn that never exec'd", async () => {
    const proc = spawn("definitely-not-a-real-binary-xyzzy", ["--nope"]);
    await new Promise<Error>((resolve) => proc.once("error", resolve));
    const killSpy = vi.spyOn(proc, "kill");
    expect(killProcessTree(proc, "SIGTERM")).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("kills descendants that outlive their parent", async () => {
    const proc = await spawnTree("sleep 300 & sleep 300", 2);
    const descendants = collectDescendants(proc.pid ?? 0);
    expect(descendants.length).toBeGreaterThanOrEqual(2);

    killProcessTree(proc, "SIGTERM", { graceMs: 200 });
    expect(await until(() => descendants.every((d) => !alive(d.pid)))).toBe(true);
  });

  it("SIGKILLs what survives the grace period, root included", async () => {
    const proc = await spawnTree('trap "" TERM; sleep 300 & sleep 300', 2);
    const rootPid = proc.pid ?? 0;
    const descendants = collectDescendants(rootPid);

    killProcessTree(proc, "SIGTERM", { graceMs: 100 });
    expect(alive(rootPid)).toBe(true);

    expect(await until(() => descendants.every((d) => !alive(d.pid)))).toBe(true);
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) resolve();
      else proc.once("exit", () => resolve());
    });
    expect(proc.signalCode).toBe("SIGKILL");
  });

  it("kills a process a survivor spawned during the grace period", async () => {
    const proc = await spawnTree(`sh -c 'trap "" TERM; sleep 1; sleep 300 & wait' & sleep 300`, 2);
    const snapshot = collectDescendants(proc.pid ?? 0);
    const snapshotPids = new Set(snapshot.map((d) => d.pid));
    const survivor = snapshot.find((d) => collectDescendants(d.pid).length >= 1);
    expect(survivor).toBeDefined();
    const survivorPid = survivor?.pid ?? 0;

    killProcessTree(proc, "SIGTERM", { graceMs: 3_000 });

    let late: ProcessIdentity | undefined;
    const spawned = await until(() => {
      late = collectDescendants(survivorPid).find((d) => !snapshotPids.has(d.pid));
      return late !== undefined;
    }, 2_500, 100);
    expect(spawned).toBe(true);
    const latePid = late?.pid ?? 0;
    strays.push(latePid);

    expect(await until(() => !alive(latePid) && !alive(survivorPid))).toBe(true);
  });

  it("refuses to walk a tree whose root is not our own child", async () => {
    const outer = await spawnTree("sh -c 'sleep 300 & sleep 300' & sleep 300", 3);
    const grandchild = collectDescendants(outer.pid ?? 0)
      .map((d) => d.pid)
      .find((pid) => collectDescendants(pid).length >= 2);
    expect(grandchild).toBeDefined();
    const notOurs = grandchild ?? 0;
    const itsChildren = collectDescendants(notOurs);

    const kill = vi.fn(() => true);
    const impostor = { pid: notOurs, kill, exitCode: null, signalCode: null } as unknown as ChildProcess;
    expect(killProcessTree(impostor, "SIGTERM", { graceMs: 50 })).toBe(true);

    expect(kill).toHaveBeenCalledWith("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    expect(itsChildren.every((d) => alive(d.pid))).toBe(true);
  });

  it("reports the whole chain, not just direct children", async () => {
    const proc = await spawnTree("sh -c 'sleep 300 & sleep 300' & sleep 300", 3);
    const pids = collectDescendants(proc.pid ?? 0).map((d) => d.pid);
    expect(pids.length).toBeGreaterThanOrEqual(3);
    expect(pids).not.toContain(proc.pid);

    killProcessTree(proc, "SIGTERM", { graceMs: 200 });
    expect(await until(() => pids.every((pid) => !alive(pid)))).toBe(true);
  });
});
