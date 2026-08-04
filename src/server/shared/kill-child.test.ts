import { describe, it, expect, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { killChild } from "./kill-child.js";

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
