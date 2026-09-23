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

describe("codex home-init", () => {
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

  describe("isCodexHomeInitialized", () => {
    it("is false for a root holding only credentials", () => {
      fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
      expect(isCodexHomeInitialized(codexHome)).toBe(false);
    });

    it("is false for a root that does not exist", () => {
      expect(isCodexHomeInitialized(path.join(dir, "nope"))).toBe(false);
    });

    it("is true once a state db exists", () => {
      fs.writeFileSync(path.join(codexHome, "state_5.sqlite"), "");
      expect(isCodexHomeInitialized(codexHome)).toBe(true);
    });

    it("re-arms when a CLI upgrade bumps the state-db suffix", () => {
      fs.writeFileSync(path.join(codexHome, "state_9.sqlite"), "");
      expect(isCodexHomeInitialized(codexHome)).toBe(true);
    });
  });

  describe("ensureCodexHomeInitialized", () => {
    it("warms a cold root exactly once before the caller spawns", async () => {
      spawnMock.mockImplementation(() => fakeCodex(codexHome));
      await ensureCodexHomeInitialized(codexHome);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [bin, args, opts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
      expect(bin).toBe("codex");
      expect(args).toEqual(["app-server"]);
      expect(opts.env.CODEX_HOME).toBe(codexHome);
      expect(opts.env.HOME).toBe(dir);
      expect(isCodexHomeInitialized(codexHome)).toBe(true);
    });

    it("does nothing for an already-initialized root", async () => {
      fs.writeFileSync(path.join(codexHome, "state_5.sqlite"), "");
      await ensureCodexHomeInitialized(codexHome);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("single-flights concurrent callers so only one process initializes", async () => {
      spawnMock.mockImplementation(() => fakeCodex(codexHome, { delayMs: 10 }));

      await Promise.all([
        ensureCodexHomeInitialized(codexHome),
        ensureCodexHomeInitialized(codexHome),
        ensureCodexHomeInitialized(codexHome),
      ]);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(isCodexHomeInitialized(codexHome)).toBe(true);
    });

    it("keys the gate on the resolved path, so equivalent spellings share it", async () => {
      spawnMock.mockImplementation(() => fakeCodex(codexHome, { delayMs: 10 }));
      await Promise.all([
        ensureCodexHomeInitialized(codexHome),
        ensureCodexHomeInitialized(path.join(dir, ".", ".codex")),
      ]);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("serializes distinct roots independently", async () => {
      const other = path.join(dir, "other", ".codex");
      fs.mkdirSync(other, { recursive: true });
      spawnMock.mockImplementation((_bin, _args, o: { env: Record<string, string> }) =>
        fakeCodex(o.env.CODEX_HOME));

      await Promise.all([
        ensureCodexHomeInitialized(codexHome),
        ensureCodexHomeInitialized(other),
      ]);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("fails open when the codex binary is missing", async () => {
      spawnMock.mockImplementation(() => {
        const handlers: Record<string, ((arg: unknown) => void)[]> = {};
        const child = {
          pid: undefined,
          stdin: { write: vi.fn() },
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: (event: string, cb: (arg: unknown) => void) => {
            (handlers[event] ??= []).push(cb);
          },
          kill: vi.fn(),
        };
        setTimeout(() => {
          for (const cb of handlers.error ?? []) cb(new Error("spawn codex ENOENT"));
        }, 1);
        return child;
      });

      await expect(ensureCodexHomeInitialized(codexHome)).resolves.toBeUndefined();
      expect(isCodexHomeInitialized(codexHome)).toBe(false);
    });

    it("retries on a later call when the warm-up did not take", async () => {
      spawnMock.mockImplementationOnce(() => fakeCodex(codexHome, { writesState: false }));
      await ensureCodexHomeInitialized(codexHome);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      spawnMock.mockImplementationOnce(() => fakeCodex(codexHome));
      await ensureCodexHomeInitialized(codexHome);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(isCodexHomeInitialized(codexHome)).toBe(true);
    });
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

    function alive(pid: number): boolean {
      try {
        const raw = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
        return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
      } catch {
        return false;
      }
    }

    it("kills the native binary under the shim, not just the shim", async () => {
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
      // cannot pass by waiting the descendants out.
      for (let i = 0; i < 50 && roster.some((p) => alive(p.pid)); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(roster.filter((p) => alive(p.pid))).toEqual([]);
    }, 40_000);
  });
});
