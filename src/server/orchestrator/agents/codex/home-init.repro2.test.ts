import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";
import { collectDescendants, killProcessTree, type ProcessIdentity } from "../../../shared/kill-child.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: spawnMock,
}));

const {
  ensureCodexHomeInitialized,
  isCodexHomeInitialized,
  resetCodexHomeInitForTests,
} = await import("./home-init.js");

function fakeCodex(codexHome: string, opts: { writesState?: boolean; delayMs?: number } = {}) {
  const stdoutHandlers: ((chunk: Buffer) => void)[] = [];
  const closeHandlers: ((code: number) => void)[] = [];
  const child = {
    pid: 4242,
    stdin: { write: vi.fn() },
    stdout: { on: (_e: string, cb: (chunk: Buffer) => void) => stdoutHandlers.push(cb) },
    stderr: { on: vi.fn() },
    on: (event: string, cb: (code: number) => void) => {
      if (event === "close") closeHandlers.push(cb);
    },
    kill: vi.fn(() => true),
  };
  setTimeout(() => {
    if (opts.writesState !== false) {
      fs.writeFileSync(path.join(codexHome, "state_5.sqlite"), "");
    }
    for (const cb of stdoutHandlers) cb(Buffer.from('{"id":0,"result":{}}\n'));
    for (const cb of closeHandlers) cb(0);
  }, opts.delayMs ?? 1);
  return child;
}

describe("codex home-init repro2", () => {
  let dir: string;
  let codexHome: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-init-"));
    codexHome = path.join(dir, ".codex");
    fs.mkdirSync(codexHome);
    spawnMock.mockReset();
    resetCodexHomeInitForTests();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  /**
   * The `codex` on PATH is a Node shim that runs the native binary as a child,
   * so the warm-up's teardown signals a wrapper while the work lives one level
   * down. This drives a shim that deliberately does not forward the signal,
   * which is what ShipIt's teardown has to hold without (planning#615).
   */
  describe.skipIf(!fs.existsSync("/proc/1/stat"))("warm-up teardown", () => {
    let spawned: ReturnType<typeof ChildProcess.spawn>[];

    beforeEach(() => {
      spawned = [];
    });

    afterEach(() => {
      // An assertion that throws before the kill would otherwise leak `sleep`s
      // for the rest of the run, including when testing a broken implementation.
      for (const proc of spawned) killProcessTree(proc, "SIGKILL");
    });

    // A reaped zombie shows `X` until its pid is released, so `Z` alone flips
    // a dead process back to alive for one read.
    function alive(pid: number): boolean {
      try {
        const raw = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
        const state = raw.slice(raw.lastIndexOf(")") + 2).split(" ")[0];
        return state !== "Z" && state !== "X";
      } catch {
        return false;
      }
    }

    function oldAlive(pid: number): boolean {
      try {
        const raw = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
        return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
      } catch {
        return false;
      }
    }

    it("kills the native binary under the shim, not just the shim", { timeout: 40_000, repeats: Number(process.env.REPRO_REPEATS ?? 50) }, async () => {
      // The background subshell is forked before the `echo` that triggers the
      // teardown, so it is always in the roster read below. `exec` makes the
      // root pid the foreground `sleep`, leaving that subshell the only claim.
      const script = [
        "{ sleep 30; } &",
        `echo '{"id":0,"result":{}}'`,
        "exec sleep 60",
      ].join("\n");
      const real = await vi.importActual<typeof ChildProcess>("node:child_process");
      let roster: ProcessIdentity[] = [];
      spawnMock.mockImplementation(() => {
        fs.writeFileSync(path.join(codexHome, "state_5.sqlite"), "");
        const proc = real.spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
        spawned.push(proc);
        // The warm-up kills on the first stdout chunk, so this is the last
        // moment the roster can be read while the root is still alive.
        proc.stdout.once("data", () => {
          roster = proc.pid === undefined ? [] : collectDescendants(proc.pid);
        });
        return proc;
      });

      await ensureCodexHomeInitialized(codexHome);
      // A vacuous pass otherwise: with no descendants there is nothing to leak.
      expect(roster.length).toBeGreaterThan(0);

      // Bounded well under the fixture's 30s sleep, so an unfixed teardown
      // cannot pass by waiting the descendants out. The verdict is the read
      // that ended the wait, not a second one taken after it.
      let survivors = roster.filter((p) => alive(p.pid));
      let oldLoopSaw = roster.some((p) => oldAlive(p.pid));
      let oldVerdict: ProcessIdentity[] = [];
      let i = 0;
      for (; i < 50 && survivors.length > 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        survivors = roster.filter((p) => alive(p.pid));
        oldLoopSaw = roster.some((p) => oldAlive(p.pid));
      }
      if (!oldLoopSaw) oldVerdict = roster.filter((p) => oldAlive(p.pid));
      fs.appendFileSync("/persist/flaky/repro2.log",
        `${process.pid} iters=${i} new=${survivors.length} old=${oldVerdict.length}\n`);
      expect(survivors).toEqual([]);
    });
  });
});
