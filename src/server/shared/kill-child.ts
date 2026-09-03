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
import { readFileSync, readdirSync } from "node:fs";

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

// ---- Process-tree teardown (planning#509) ----

/**
 * A process identified by pid AND the boot-relative `starttime` of that pid's
 * current occupant. The pair is what makes a delayed signal safe: a bare pid
 * recorded now may name a DIFFERENT process by the time we signal it, and the
 * whole reason {@link killChild} exists is that signalling a pid you cannot
 * vouch for shoots an unrelated bystander.
 */
export interface ProcessIdentity {
  pid: number;
  /** `starttime`, field 22 of `/proc/<pid>/stat` — clock ticks since boot. */
  startTime: number;
}

/** Grace between the tree's SIGTERM and the SIGKILL sweep of whatever survived. */
const TREE_KILL_GRACE_MS = 5_000;

/**
 * Parse the two fields we need out of `/proc/<pid>/stat`, or null if the
 * process is gone (or we are not on Linux).
 *
 * The `comm` field is parenthesized and may itself contain spaces and
 * parentheses, so everything is read relative to the LAST `)` — after which
 * the fields resume at `state` (field 3). Hence ppid (field 4) is index 1 and
 * starttime (field 22) is index 19.
 */
function readProcStat(
  pid: number,
): { pid: number; ppid: number; startTime: number; zombie: boolean } | null {
  try {
    const raw = readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    const close = raw.lastIndexOf(")");
    if (close === -1) return null;
    const fields = raw.slice(close + 2).split(" ");
    const ppid = Number.parseInt(fields[1] ?? "", 10);
    const startTime = Number.parseInt(fields[19] ?? "", 10);
    if (!Number.isFinite(ppid) || !Number.isFinite(startTime)) return null;
    return { pid, ppid, startTime, zombie: fields[0] === "Z" };
  } catch {
    return null;
  }
}

/**
 * Every descendant of `rootPid` right now, breadth-first, excluding `rootPid`
 * itself. Empty on a platform without `/proc` (macOS dev machines) — the
 * production runtime is Linux containers, and the caller degrades to signalling
 * the root alone, which is the behaviour that predates this helper.
 *
 * Scans all of `/proc` rather than reading `/proc/<pid>/task/<tid>/children`:
 * the latter is kernel-config-dependent and documented as unreliable for a
 * process with many threads, while a container's process table is tiny.
 */
export function collectDescendants(rootPid: number): ProcessIdentity[] {
  return descendantsOf([rootPid], readProcessTable());
}

/** `ppid` → its live children, for every process `/proc` will show us. */
type ProcessTable = Map<number, ProcessIdentity[]>;

function readProcessTable(): ProcessTable {
  const childrenOf: ProcessTable = new Map();
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return childrenOf;
  }

  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    if (!Number.isFinite(pid) || String(pid) !== entry) continue;
    const stat = readProcStat(pid);
    // A zombie is already dead: it holds no CPU, cannot be signalled, and — its
    // own children having been reparented the moment it exited — hides nothing
    // below it. Listing one would only inflate the counts we log.
    if (!stat || stat.zombie) continue;
    const siblings = childrenOf.get(stat.ppid);
    const row = { pid: stat.pid, startTime: stat.startTime };
    if (siblings) siblings.push(row);
    else childrenOf.set(stat.ppid, [row]);
  }
  return childrenOf;
}

/** Breadth-first descendants of every pid in `roots`, excluding the roots. */
function descendantsOf(roots: number[], childrenOf: ProcessTable): ProcessIdentity[] {
  const found: ProcessIdentity[] = [];
  const seen = new Set<number>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift() ?? 0;
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/**
 * Signal `identity` only if that pid is still occupied by the process we
 * recorded. Returns true when the signal was delivered.
 *
 * Never signals pid 0 (the caller's whole process group), pid 1 (init), or our
 * own process, whatever the caller passes.
 *
 * The stat and the `kill(2)` are two syscalls, so this narrows the recycled-pid
 * window rather than closing it: from the 5s grace, where recycling is
 * plausible, to the microseconds between two adjacent calls, in which the kernel
 * would have to allocate around the entire pid space to land on this number.
 * Closing it outright needs `pidfd_open`/`pidfd_send_signal`, which Node exposes
 * no binding for.
 */
function signalIdentity(identity: ProcessIdentity, signal: NodeJS.Signals): boolean {
  const { pid, startTime } = identity;
  if (pid <= 1 || pid === process.pid) return false;
  const current = readProcStat(pid);
  if (!current || current.zombie || current.startTime !== startTime) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    // ESRCH — it exited between the stat and the kill.
    return false;
  }
}

/**
 * Terminate `child` **and everything it spawned**, then SIGKILL whatever is
 * still alive {@link TREE_KILL_GRACE_MS} later.
 *
 * ## Why a `/proc` walk and not a process-group kill
 *
 * The obvious mechanism is `detached: true` at spawn (which is `setsid`) plus
 * `process.kill(-pid, sig)`. It is simpler, and it is not sufficient here: an
 * agent CLI's MCP servers put their own children in fresh groups. Playwright is
 * the case this helper exists for — `launchProcess` in playwright-core spawns
 * every browser with `detached: process.platform !== "win32"`, expressly so it
 * can kill the browser's group itself. So a Chromium started by
 * `@playwright/mcp` is a session leader in a group of its own, and a signal to
 * the CLI's group never reaches it.
 *
 * That is the observed leak (production host, 2026-09-03): a Codex turn opened
 * a Playwright browser, the turn ended, the app-server and the MCP server both
 * died — and the Chromium tree lived on for another ~19 minutes, reparented to
 * the container's pid 1, with a renderer burning half a core animating a page
 * nobody was watching. Killing the CLI's group would not have caught it; a
 * parent-chain walk does, because at the instant we signal, the browser is
 * still a descendant of the MCP server which is still a descendant of the CLI.
 *
 * Hence the ordering: **snapshot first, then signal**. Once the CLI dies its
 * grandchildren are orphaned onto pid 1 and no walk can find them again, so the
 * snapshot taken before the first signal is the only record the sweep has. The
 * sweep re-walks anyway and unions the two, to catch anything spawned in the
 * gap.
 *
 * ## Two guards against shooting a bystander
 *
 * `killChild`'s hazard — signalling a pid you cannot vouch for — gets worse
 * once the signal leaves the `ChildProcess` object, because a raw
 * `process.kill(pid)` is not intercepted by a test's fake or bounded by libuv's
 * bookkeeping. So:
 *
 *   - the tree is walked ONLY when `/proc` says the root's parent is us. A pid
 *     that is not our own child is not a tree we may tear down — and a fabricated
 *     pid (adapter tests carry `4242`, `12345`) is exactly that. The root itself
 *     still gets its signal through `killChild`, as before;
 *   - every delayed signal re-checks the pid's `starttime`
 *     ({@link signalIdentity}), so a pid reaped and recycled during the grace
 *     cannot be shot.
 *
 * `signal` reaches the root through {@link killChild}, so the caller's existing
 * semantics are unchanged; this only widens the blast radius from one pid to the
 * tree. Callers that send SIGINT *first* to let a CLI flush (the Claude and
 * OpenCode interrupt paths) keep doing that with plain `killChild` and reach
 * this helper through their own escalation.
 */
export function killProcessTree(
  child: ChildProcess | null | undefined,
  signal: NodeJS.Signals = "SIGTERM",
  opts: { label?: string; graceMs?: number } = {},
): boolean {
  if (child?.pid === undefined) return false;
  const rootPid = child.pid;
  const label = opts.label ?? "agent";
  const graceMs = opts.graceMs ?? TREE_KILL_GRACE_MS;

  // BEFORE the signal — see the docstring.
  const rootStat = readProcStat(rootPid);
  const ours = rootStat !== null && rootStat.ppid === process.pid;
  if (rootStat && !ours) {
    console.warn(
      `[kill-tree] ${label} pid=${String(rootPid)} is not our child (ppid=${String(rootStat.ppid)})`
      + " — signalling it alone, not its tree",
    );
  }
  const snapshot = ours ? collectDescendants(rootPid) : [];

  const killed = killChild(child, signal);

  let signalled = 0;
  for (const descendant of snapshot) {
    if (signalIdentity(descendant, signal)) signalled++;
  }
  if (snapshot.length > 0) {
    console.log(
      `[kill-tree] ${label} pid=${String(rootPid)}: ${signal} to ${String(signalled)}/${String(snapshot.length)} descendant(s)`,
    );
  }

  if (ours && rootStat) {
    const root: ProcessIdentity = { pid: rootPid, startTime: rootStat.startTime };
    scheduleSweep(root, [root, ...snapshot], graceMs, label);
  }

  return killed;
}

/**
 * SIGKILL anything from `roster` (plus any descendant that appeared since) still
 * alive after `graceMs`. Unref'd: a pending sweep must never be the reason the
 * worker's event loop stays open.
 *
 * The re-walk starts from EVERY roster member that is still the process we
 * recorded, not from the root alone. The root is usually the first to go, and a
 * survivor below it can spawn during the grace — an MCP server that ignores
 * SIGTERM launching a browser, say — so a root-only re-walk would find nothing
 * and leave that late child running, which is the whole leak again one level
 * down. The identity check is what makes the re-walk safe: an unverified pid
 * could have been reaped and recycled, and the pids a walk *discovers* carry
 * their own identity, so {@link signalIdentity} cannot catch a bad root for
 * them.
 */
function scheduleSweep(
  root: ProcessIdentity,
  roster: ProcessIdentity[],
  graceMs: number,
  label: string,
): void {
  const timer = setTimeout(() => {
    const byPid = new Map(roster.map((p) => [p.pid, p]));
    const stillOurs = roster.filter((p) => {
      const current = readProcStat(p.pid);
      return current !== null && !current.zombie && current.startTime === p.startTime;
    });
    if (stillOurs.length > 0) {
      const late = descendantsOf(stillOurs.map((p) => p.pid), readProcessTable());
      for (const l of late) byPid.set(l.pid, l);
    }

    let killed = 0;
    for (const identity of byPid.values()) {
      if (signalIdentity(identity, "SIGKILL")) killed++;
    }
    if (killed > 0) {
      console.warn(
        `[kill-tree] ${label} pid=${String(root.pid)}: SIGKILLed ${String(killed)} process(es) that survived the grace period`,
      );
    }
  }, graceMs);
  timer.unref?.();
}
