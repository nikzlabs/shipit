/**
 * docs/329-user-steers-every-turn — the lock a flow takes while ShipIt itself changes the
 * session's branch or container: no turn starts under it. A flow owns it, never a turn.
 */
export interface SessionHold {
  /** Clears the runner's hold only while it is still this one. */
  release(): void;
}

/** A flow reads `runner.sessionHold` first: taking it does not wait for an earlier owner. */
export function takeSessionHold(runner: { sessionHold: SessionHold | null }): SessionHold {
  const hold: SessionHold = {
    release: () => {
      if (runner.sessionHold === hold) runner.sessionHold = null;
    },
  };
  runner.sessionHold = hold;
  return hold;
}
