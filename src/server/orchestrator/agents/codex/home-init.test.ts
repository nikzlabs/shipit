import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/**
 * A stand-in for `codex app-server` that performs the real side effect we care
 * about — creating the `state_<N>.sqlite` whose first-run creation is the thing
 * two concurrent CLIs race on — and then answers the `initialize` request.
 */
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
      // Matched by pattern, not by the literal `state_5` of Codex 0.146: a bump
      // re-runs first-run init, and hardcoding the name would report "warm"
      // through exactly the window that is not.
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
      // The child must agree with the caller about which root it is initializing.
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
      // The regression: naming (`codex exec`) and the turn (`codex app-server`)
      // both start against the same cold root on a session's first message, and
      // Codex's first-run init is not concurrency-safe — the loser exits 1 with
      // `failed to initialize sqlite state runtime`. Both now await this gate,
      // so exactly one process may be in the root while it is cold.
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

      // Resolves rather than throwing — a warm-up we cannot perform must never
      // block a turn, exactly like env-prep's other fail-open steps.
      await expect(ensureCodexHomeInitialized(codexHome)).resolves.toBeUndefined();
      expect(isCodexHomeInitialized(codexHome)).toBe(false);
    });

    it("retries on a later call when the warm-up did not take", async () => {
      // A failed warm-up must not be memoized as done — the root is still cold,
      // so the next caller should try again rather than walk into the race.
      spawnMock.mockImplementationOnce(() => fakeCodex(codexHome, { writesState: false }));
      await ensureCodexHomeInitialized(codexHome);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      spawnMock.mockImplementationOnce(() => fakeCodex(codexHome));
      await ensureCodexHomeInitialized(codexHome);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(isCodexHomeInitialized(codexHome)).toBe(true);
    });
  });
});
