/**
 * Session-settings writes in flight per session, across every surface: the
 * network-mode hook and the Session settings dialog's SSH grants (docs/285 req 12).
 *
 * Two readers depend on it. The composer's Send barrier holds while any write is
 * open, because a first turn sent before the write lands runs without it. And a
 * new-session claim waits for every write to settle: the server refuses to
 * recycle a draft that carries settings, and it can only see settings that have
 * landed (req 8).
 */
const inFlight = new Map<string, number>();
const listeners = new Set<() => void>();

function change(sessionId: string, delta: number): void {
  const next = (inFlight.get(sessionId) ?? 0) + delta;
  if (next > 0) inFlight.set(sessionId, next);
  else inFlight.delete(sessionId);
  for (const listener of listeners) listener();
}

/** Marks a write as in flight; call the returned function when it settles. */
export function beginSessionSettingWrite(sessionId: string): () => void {
  change(sessionId, 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    change(sessionId, -1);
  };
}

export function sessionSettingWritesInFlight(sessionId: string): number {
  return inFlight.get(sessionId) ?? 0;
}

export function subscribeSessionSettingWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Resolves once no session has a settings write in flight. */
export function allSessionSettingWritesSettled(): Promise<void> {
  if (inFlight.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const check = (): void => {
      if (inFlight.size > 0) return;
      listeners.delete(check);
      resolve();
    };
    listeners.add(check);
  });
}

/** Test-only. */
export function _resetSessionSettingWrites(): void {
  inFlight.clear();
  listeners.clear();
}
