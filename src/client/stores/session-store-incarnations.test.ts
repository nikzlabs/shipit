/**
 * docs/285 — how a viewer discovers that its runner was replaced.
 *
 * A network-mode change rebuilds the session's container, which disposes the
 * runner. Disposal removes that runner's listeners without closing the viewer's
 * socket, so a tab that was attached is left receiving nothing, forever, with no
 * error anywhere. The incarnation counter is the signal that it should reattach.
 *
 * Two paths arrive here and they must be believed differently. The SSE connect
 * SNAPSHOT is a full map and needs the strict-greater rule: a server that
 * restarted reports lower numbers for everything, and reading that as "your
 * runner was replaced" makes every tab reconnect in a loop. The LIVE
 * `runner_replaced` event names the one session it replaced, so it needs no
 * earlier generation to be believed — and requiring one excluded exactly the
 * sessions this feature acts on.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "./session-store.js";

function reset(sessionId: string | null): void {
  useSessionStore.setState({
    sessionId,
    runnerIncarnations: {},
    staleRunnerNonce: 0,
  } as never);
}

const nonce = (): number => useSessionStore.getState().staleRunnerNonce;

describe("runner incarnations (docs/285)", () => {
  beforeEach(() => reset("s1"));

  it("treats a LIVE replacement as authoritative with no prior generation", () => {
    // The case that was silently excluded. A `/new` viewer has never seen an
    // earlier generation for its session, and a warm session is absent from the
    // session list the snapshot is built from — so requiring a baseline meant
    // the sessions a network-mode rebuild replaces were the ones that never
    // reconnected.
    useSessionStore.getState().noteRunnerIncarnations({ s1: 2 }, { merge: true, live: true });
    expect(nonce()).toBe(1);
  });

  it("still reacts to a live replacement when a baseline exists", () => {
    useSessionStore.getState().noteRunnerIncarnations({ s1: 1 });
    expect(nonce()).toBe(0);
    useSessionStore.getState().noteRunnerIncarnations({ s1: 2 }, { merge: true, live: true });
    expect(nonce()).toBe(1);
  });

  it("does not reconnect on a SNAPSHOT with no prior generation", () => {
    // The first snapshot after connecting is not news; every session in it would
    // otherwise read as replaced and the tab would reconnect on arrival.
    useSessionStore.getState().noteRunnerIncarnations({ s1: 3 });
    expect(nonce()).toBe(0);
  });

  it("ignores a snapshot that goes BACKWARDS", () => {
    // A restarted server counts from zero again. Reading that as a replacement
    // makes every tab reconnect in a loop against a server already handing them
    // fresh runners.
    useSessionStore.getState().noteRunnerIncarnations({ s1: 5 });
    useSessionStore.getState().noteRunnerIncarnations({ s1: 2 });
    expect(nonce()).toBe(0);
  });

  it("ignores a replacement of a session this tab is not looking at", () => {
    useSessionStore.getState().noteRunnerIncarnations({ s2: 9 }, { merge: true, live: true });
    expect(nonce()).toBe(0);
  });

  it("does nothing when no session is active", () => {
    reset(null);
    useSessionStore.getState().noteRunnerIncarnations({ s1: 4 }, { merge: true, live: true });
    expect(nonce()).toBe(0);
  });
});
