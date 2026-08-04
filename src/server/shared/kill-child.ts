/**
 * Safe `ChildProcess.kill()` for processes that may have failed to spawn.
 *
 * When `spawn()` cannot exec the binary (ENOENT — `docker` in a session
 * container, `git-lfs` on a host without it, an agent CLI that isn't
 * installed), Node reports the failure asynchronously via an `'error'` event
 * and leaves `child.pid` `undefined`. The `uv_process_t` behind it, however,
 * still carries an **uninitialized `pid` field**, and `ChildProcess.kill()`
 * hands that straight to libuv:
 *
 *     child.kill()  →  uv_process_kill(handle, sig)  →  kill(handle->pid, sig)
 *
 * The call returns `false`, which reads like "nothing happened" — but the
 * `kill(2)` syscall really is issued, against a garbage pid. Observed values
 * in one container: 796029813, 285242473, and `64` — a live process, which
 * duly received the SIGTERM. So a best-effort `child.kill()` on a failed
 * spawn is a live grenade: it shoots an arbitrary unrelated process, and the
 * damage is invisible at the call site.
 *
 * That is not theoretical. `npm test` inside a ShipIt session container has
 * no `docker` binary, so every ServiceManager teardown fired one of these,
 * and the SIGTERMs landed on vitest workers, the vitest runner, and the shell
 * running the suite — surfacing as runs that died part-way through with exit
 * 143 at a different test every time. It read like an OOM; it was friendly
 * fire.
 *
 * `child.pid === undefined` is exactly the "spawn failed, handle never got a
 * real pid" condition, so gating on it removes the syscall entirely.
 */
import type { ChildProcess } from "node:child_process";

/**
 * Kill `child` only if it actually spawned. No-ops (returning `false`) when
 * the spawn failed, instead of signalling a random pid.
 *
 * Use this anywhere a spawn's binary might be missing. `kill()` on a process
 * that spawned and has since exited is already safe — the pid is real and
 * libuv reports ESRCH — so this only ever suppresses the dangerous case.
 */
export function killChild(child: ChildProcess | null | undefined, signal?: NodeJS.Signals | number): boolean {
  if (child?.pid === undefined) return false;
  try {
    return child.kill(signal);
  } catch {
    // ESRCH / EPERM against an already-reaped pid — nothing left to kill.
    return false;
  }
}
