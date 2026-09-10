import type { ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

/** A failed spawn has no pid; calling kill() can signal an unrelated process. */
export function killChild(child: ChildProcess | null | undefined, signal?: NodeJS.Signals | number): boolean {
  if (child?.pid === undefined) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

export interface ProcessIdentity {
  pid: number;
  /** Field 22 of /proc/<pid>/stat: clock ticks since boot. */
  startTime: number;
}

const TREE_KILL_GRACE_MS = 5_000;

function readProcStat(
  pid: number,
): { pid: number; ppid: number; startTime: number; zombie: boolean } | null {
  try {
    const raw = readFileSync(`/proc/${String(pid)}/stat`, "utf-8");
    // comm can contain parentheses; fields after its last ')' start at field 3.
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

/** Empty without /proc. Per-thread children lists are not reliable here. */
export function collectDescendants(rootPid: number): ProcessIdentity[] {
  return descendantsOf([rootPid], readProcessTable());
}

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
    if (!stat || stat.zombie) continue;
    const siblings = childrenOf.get(stat.ppid);
    const row = { pid: stat.pid, startTime: stat.startTime };
    if (siblings) siblings.push(row);
    else childrenOf.set(stat.ppid, [row]);
  }
  return childrenOf;
}

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

// The identity check narrows the PID reuse race; only pidfds could close it.
function signalIdentity(identity: ProcessIdentity, signal: NodeJS.Signals): boolean {
  const { pid, startTime } = identity;
  if (pid <= 1 || pid === process.pid) return false;
  const current = readProcStat(pid);
  if (!current || current.zombie || current.startTime !== startTime) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Snapshot before signalling: descendants can be reparented when the root exits.
 * Process-group kills miss browsers that start their own groups.
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

  // Reject exited handles and test doubles before trusting a possibly reused pid.
  const live = child.exitCode === null && child.signalCode === null;
  const rootStat = live ? readProcStat(rootPid) : null;
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

// Re-walk every verified survivor: the root can exit while descendants still spawn.
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
