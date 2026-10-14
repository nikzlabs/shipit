// docs/331-persist-own-volume: one per-session gate orders every user of /persist.
import { AsyncLocalStorage } from "node:async_hooks";

export type PersistLeaseMode = "shared" | "exclusive";

interface Lease {
  readonly sessionId: string;
  readonly mode: PersistLeaseMode;
  active: boolean;
}

interface Waiter {
  mode: PersistLeaseMode;
  grant: () => void;
}

interface Gate {
  readers: number;
  writer: boolean;
  waiting: Waiter[];
}

export class PersistGateTimeoutError extends Error {
  constructor(sessionId: string, mode: PersistLeaseMode, timeoutMs: number) {
    super(`/persist of ${sessionId} stayed in use for ${Math.round(timeoutMs / 1000)}s; the ${mode} lease was not granted`);
    this.name = "PersistGateTimeoutError";
  }
}

const gates = new Map<string, Gate>();
const held = new AsyncLocalStorage<readonly Lease[]>();

/**
 * Runs `fn` under the session's gate. Inside an exclusive lease every request of the same session
 * borrows it (rule 2); a shared request inside a shared lease is counted at once, so a waiting
 * exclusive request cannot deadlock it. A lease outlives nothing: work started inside it that runs
 * after it ends asks again.
 */
export async function withPersistLease<T>(
  sessionId: string,
  mode: PersistLeaseMode,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const leases = (held.getStore() ?? []).filter((lease) => lease.active);
  const mine = leases.find((lease) => lease.sessionId === sessionId);
  if (mine?.mode === "exclusive") return fn();
  if (mine && mode === "exclusive") {
    throw new Error(`ShipIt asked for the exclusive /persist lease of ${sessionId} while it held the shared one.`);
  }
  let gate = gates.get(sessionId);
  if (!gate) {
    gate = { readers: 0, writer: false, waiting: [] };
    gates.set(sessionId, gate);
  }
  if (mine) gate.readers++;
  else await acquire(sessionId, gate, mode, opts.timeoutMs);
  const lease: Lease = { sessionId, mode, active: true };
  try {
    return await held.run([...leases, lease], fn);
  } finally {
    lease.active = false;
    release(sessionId, gate, mode);
  }
}

function grantable(gate: Gate, mode: PersistLeaseMode): boolean {
  return mode === "shared" ? !gate.writer : !gate.writer && gate.readers === 0;
}

function take(gate: Gate, mode: PersistLeaseMode): void {
  if (mode === "shared") gate.readers++;
  else gate.writer = true;
}

// First come, first served: a waiting exclusive request holds back later shared ones.
function acquire(sessionId: string, gate: Gate, mode: PersistLeaseMode, timeoutMs: number | undefined): Promise<void> {
  if (gate.waiting.length === 0 && grantable(gate, mode)) {
    take(gate, mode);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      const index = gate.waiting.indexOf(waiter);
      if (index < 0) return;
      gate.waiting.splice(index, 1);
      // The requests behind it may be grantable now.
      grantWaiting(sessionId, gate);
      reject(new PersistGateTimeoutError(sessionId, mode, timeoutMs));
    }, timeoutMs);
    timer?.unref?.();
    const waiter: Waiter = {
      mode,
      grant: () => {
        if (timer) clearTimeout(timer);
        resolve();
      },
    };
    gate.waiting.push(waiter);
  });
}

function release(sessionId: string, gate: Gate, mode: PersistLeaseMode): void {
  if (mode === "shared") gate.readers--;
  else gate.writer = false;
  grantWaiting(sessionId, gate);
}

function grantWaiting(sessionId: string, gate: Gate): void {
  while (gate.waiting.length > 0 && grantable(gate, gate.waiting[0].mode)) {
    const next = gate.waiting.shift()!;
    take(gate, next.mode);
    next.grant();
  }
  if (!gate.writer && gate.readers === 0 && gate.waiting.length === 0 && gates.get(sessionId) === gate) {
    gates.delete(sessionId);
  }
}
