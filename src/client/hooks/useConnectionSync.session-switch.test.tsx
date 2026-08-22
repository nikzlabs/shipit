import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { useSessionWebSocket } from "./useSessionWebSocket.js";
import { useConnectionSync } from "./useConnectionSync.js";
import { useMessageHandler } from "./useMessageHandler.js";
import { useSessionStore } from "../stores/session-store.js";
import { resumeSessionInternal } from "../stores/actions/session-actions.js";
import { __resetHistoryCache } from "../utils/session-data.js";

/**
 * Hydration ordering over the REAL hook composition — `useSessionWebSocket` +
 * `useConnectionSync` + `useMessageHandler`, in App's order — because every bug
 * here lives in the seam between them and none of it reproduces in a hook
 * tested alone.
 *
 * `historyLoaded` is the ordering guard that makes the attach-time
 * `turn_snapshot` land ON TOP of the `GET /history` baseline rather than under
 * it: `useMessageHandler` queues the snapshot only while the flag is false.
 * Losing that ordering is what produced "switch away mid-turn, switch back, and
 * part of the running turn is gone until a reload".
 *
 * One rule holds the whole file together: **the store flag is the single source
 * of truth for whether the transcript has its baseline, and hydration keys on
 * it.** Each test pins a sequence that a plausible simplification would break —
 * a socket that never changes status, a resume that never moves the socket, a
 * load still running after it raised the flag, an open that needs no load, and
 * the stale-`"open"` render at the start of an ordinary switch.
 */

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send = vi.fn();
  close() { this.readyState = FakeWebSocket.CLOSED; }

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

/** Resolvers for the deferred `GET /history` responses, in issue order. */
let historyResolvers: ((payload: unknown) => void)[] = [];
/**
 * `loadSessionHistory` raises `historyLoaded` and then keeps going, awaiting
 * preview status. Deferring that tail is how a test holds a load "in flight
 * past the flag flip".
 */
let previewStatusResolvers: ((payload: unknown) => void)[] = [];
let deferPreviewStatus = false;
/**
 * Opt-in ETag for `GET /history` (planning#467). Off by default so every test
 * above keeps taking the plain `200` path — switching them all to a cached
 * `304` would stop `json()` being called and hang their `historyResolvers`
 * waits. Set it to make the second load for a session revalidate.
 */
let historyEtag: string | null = null;
/**
 * Hold the `GET /history` *response* itself, rather than its `json()` body.
 * A `304` never calls `json()`, so deferring the body cannot hold a cached load
 * open — and a load that has already completed cannot be raced by the attach
 * snapshot, which is the thing the ordering test has to reproduce.
 */
let deferHistoryFetch = false;
let historyFetchResolvers: (() => void)[] = [];

/** The three hooks App composes for a session's transport, in App's order. */
function useConnectionStack(sessionId: string) {
  const ws = useSessionWebSocket(sessionId);
  useConnectionSync({ status: ws.status, send: ws.send });
  const terminalRef = useRef(null);
  useMessageHandler({
    lastMessage: ws.lastMessage,
    drainMessages: ws.drainMessages,
    send: ws.send as never,
    terminalRef,
  });
  return ws;
}

/** A running turn's persisted rows: in-progress, so a snapshot replaces them. */
function historyPayload(texts: string[]) {
  return {
    messages: texts.map((text) => ({ role: "assistant", text, inProgress: true })),
    commits: [],
    fileTree: [],
    agentRunning: true,
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  historyResolvers = [];
  previewStatusResolvers = [];
  deferPreviewStatus = false;
  historyEtag = null;
  deferHistoryFetch = false;
  historyFetchResolvers = [];
  __resetHistoryCache();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/history")) {
      if (historyEtag === null) {
        return Promise.resolve({
          ok: true,
          json: () => new Promise((resolve) => historyResolvers.push(resolve)),
        });
      }
      const headers = new Headers({ etag: historyEtag });
      const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.["If-None-Match"];
      const res = ifNoneMatch === historyEtag
        ? { ok: true, status: 304, headers, json: () => { throw new Error("must not parse a 304"); } }
        : { ok: true, status: 200, headers, json: () => new Promise((resolve) => historyResolvers.push(resolve)) };
      if (!deferHistoryFetch) return Promise.resolve(res);
      return new Promise((resolve) => historyFetchResolvers.push(() => resolve(res)));
    }
    if (url.includes("/preview-status")) {
      return Promise.resolve({
        ok: true,
        json: () => deferPreviewStatus
          ? new Promise((resolve) => previewStatusResolvers.push(resolve))
          : Promise.resolve({ known: true, running: false }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: [], repos: [], agents: [] }) });
  }));
  useSessionStore.getState().reset();
  useSessionStore.setState({ sessions: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetHistoryCache();
});

describe("transcript hydration across session switches and reconnects", () => {
  it("keeps the incoming session's attach snapshot instead of its stale history baseline", async () => {
    useSessionStore.getState().setSessionId("A");
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useConnectionStack(id),
      { initialProps: { id: "A" } },
    );

    // A's socket opens; its history load goes out and stays in flight.
    await act(async () => { FakeWebSocket.instances[0].simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(1));

    // A reconnect (the Reconnect button, or the foreground force-reconnect)
    // while that load is in flight: open -> connecting.
    await act(async () => { result.current.reconnect(); });
    expect(result.current.status).toBe("connecting");
    expect(useSessionStore.getState().historyLoaded).toBe(false);

    // The load lands late and raises the flag while the socket is connecting.
    await act(async () => { historyResolvers[0](historyPayload(["A baseline"])); });
    expect(useSessionStore.getState().historyLoaded).toBe(true);

    // Now switch to B. The new URL rebuilds the socket, but `setStatus` is
    // handed the value it already holds, so `useConnectionSync` never re-runs.
    await act(async () => {
      resumeSessionInternal("B");
      rerender({ id: "B" });
    });
    expect(result.current.status).toBe("connecting");
    expect(useSessionStore.getState().historyLoaded).toBe(false);

    // B's socket attaches mid-turn: snapshot on the wire first, history after.
    const socketB = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    await act(async () => { socketB.simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(2));
    await act(async () => {
      socketB.simulateMessage({
        type: "turn_snapshot",
        sessionId: "B",
        messages: [{ role: "assistant", text: "B live tail" }],
      });
    });
    await act(async () => { historyResolvers[1](historyPayload(["B stale baseline"])); });

    // The snapshot is authoritative for the running turn: the baseline's
    // in-progress rows are replaced, not the other way round.
    await waitFor(() => {
      expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["B live tail"]);
    });
  });

  /**
   * planning#467 asked whether a validated `304` opens a live transcript-
   * truncation window: the cached payload holds only persisted rows, and
   * re-installing it wholesale wipes everything the running turn has streamed
   * since its last boundary.
   *
   * It does not, and the reason is the same `historyLoaded` gate the rest of
   * this file is about — nothing specific to the `304`. The reconnect lowers
   * the flag, `useMessageHandler` queues the attach snapshot behind it, the
   * install raises it, and the drain then replaces the in-progress rows with
   * the snapshot's. Pinned END-TO-END on the cached path because the reasoning
   * spans four files and the `304` reaches the install by a different route,
   * so neither the store test nor a hook tested alone can fail on a break here.
   */
  it("restores the running turn's tail after a reconnect whose history load answered 304", async () => {
    historyEtag = '"v1"';
    useSessionStore.getState().setSessionId("A");
    const { result } = renderHook(({ id }: { id: string }) => useConnectionStack(id), {
      initialProps: { id: "A" },
    });

    // First open: a 200 that caches the payload.
    await act(async () => { FakeWebSocket.instances[0].simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(1));
    await act(async () => { historyResolvers[0](historyPayload(["persisted"])); });
    expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["persisted"]);

    // The turn streams on, past the last persist boundary.
    act(() => {
      useSessionStore.getState().setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "streamed since", inProgress: true },
      ]);
    });

    // Foreground force-reconnect. Nothing was persisted in the gap, so the
    // server will revalidate — and the response is held so the attach snapshot
    // genuinely races it, which is the whole point.
    deferHistoryFetch = true;
    await act(async () => { result.current.reconnect(); });
    expect(useSessionStore.getState().historyLoaded).toBe(false);

    const reconnected = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    await act(async () => { reconnected.simulateOpen(); });
    await waitFor(() => expect(historyFetchResolvers).toHaveLength(1));

    // Snapshot first on the wire, with the load still outstanding.
    await act(async () => {
      reconnected.simulateMessage({
        type: "turn_snapshot",
        sessionId: "A",
        messages: [
          { role: "assistant", text: "persisted" },
          { role: "assistant", text: "streamed since" },
          { role: "assistant", text: "produced while we were down" },
        ],
      });
    });
    // Queued, not applied. The third row is what makes this discriminating: a
    // snapshot dispatched immediately would already have added it.
    expect(useSessionStore.getState().messages.map((m) => m.text))
      .toEqual(["persisted", "streamed since"]);

    // Now the 304 lands and installs the cached payload, which holds the
    // persisted row alone.
    await act(async () => { historyFetchResolvers[0](); });
    await waitFor(() => expect(useSessionStore.getState().historyLoaded).toBe(true));
    // No body was ever parsed on the reconnect.
    expect(historyResolvers).toHaveLength(1);

    // …and the drain put the snapshot on top of it, so the tail is intact.
    await waitFor(() => {
      expect(useSessionStore.getState().messages.map((m) => m.text))
        .toEqual(["persisted", "streamed since", "produced while we were down"]);
    });
  });

  /**
   * The counterpart hazard: the baseline being lowered by something that does
   * NOT move the socket. Hydration has to be keyed on the flag itself, or the
   * transcript sits cleared with every incoming event queued behind a load that
   * is never issued.
   *
   * Driven by lowering the flag directly rather than through a resume of the
   * session already on screen, which is what this used to do: that resume is now
   * a no-op (planning#467 — it destroyed a running turn's tail with no attach
   * coming to restore it, see the test below), so it can no longer stand in for
   * "something lowered the flag". The property is unchanged and still live — a
   * switch that begins while the socket is already connecting lowers the flag
   * with `setStatus("connecting")` a no-op, which is the first test in this file.
   */
  it("re-issues the history load whenever the baseline is lowered without moving the socket", async () => {
    useSessionStore.getState().setSessionId("A");
    renderHook(({ id }: { id: string }) => useConnectionStack(id), {
      initialProps: { id: "A" },
    });

    await act(async () => { FakeWebSocket.instances[0].simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(1));
    await act(async () => { historyResolvers[0](historyPayload(["A baseline"])); });
    expect(useSessionStore.getState().historyLoaded).toBe(true);

    // Same id, same URL, same socket — only the flag moves.
    await act(async () => { useSessionStore.getState().setHistoryLoaded(false); });

    await waitFor(() => expect(historyResolvers).toHaveLength(2));
    await act(async () => { historyResolvers[1](historyPayload(["A baseline"])); });
    expect(useSessionStore.getState().historyLoaded).toBe(true);
    expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["A baseline"]);
  });

  /**
   * planning#467, found by review — the ONE path where the running turn's tail
   * is genuinely lost, and the reason it is not a `304` problem.
   *
   * Every other entry into `loadSessionHistory` is preceded by an attach, so a
   * `turn_snapshot` follows the install and restores whatever the payload did
   * not carry. A resume of the session ALREADY ON SCREEN is the exception: the
   * session id does not change, so `useSessionWebSocket`'s memoized URL does not
   * change, so no socket is built and the server never attaches. Nothing is
   * coming to repair the install — and `resumeSessionInternal` has already
   * cleared the transcript by then, so it is the CLEAR that loses the tail, not
   * the install. Skipping the install would not have saved it.
   *
   * So the reset is skipped when the session is already the current one. There
   * is nothing for it to do there: the stores it clears belong to the session
   * being resumed.
   */
  it("keeps the running turn's unpersisted tail when the session already on screen is resumed", async () => {
    useSessionStore.getState().setSessionId("A");
    renderHook(({ id }: { id: string }) => useConnectionStack(id), {
      initialProps: { id: "A" },
    });

    await act(async () => { FakeWebSocket.instances[0].simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(1));
    await act(async () => { historyResolvers[0](historyPayload(["persisted"])); });

    // The turn streams past its last persist boundary. This row exists ONLY in
    // memory — no payload carries it, and with no attach no snapshot will.
    act(() => {
      useSessionStore.getState().setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "streamed since", inProgress: true },
      ]);
    });

    // "All Sessions" renders even the active session as selectable
    // (`AllSessionsDialog.tsx` passes `isCurrent={false}`), so this is one
    // click away at any time.
    await act(async () => { resumeSessionInternal("A"); });

    expect(useSessionStore.getState().messages.map((m) => m.text))
      .toEqual(["persisted", "streamed since"]);
  });

  /**
   * The same snapshot-under-history loss, reached WITHOUT a session switch: a
   * plain reconnect whose old history response resolves while the replacement
   * socket is still connecting. The transcript then already has its baseline,
   * so the reconnect must not issue a second destructive load underneath the
   * snapshot the new attach is about to deliver.
   */
  it("keeps the attach snapshot when a reconnect's old history response landed first", async () => {
    useSessionStore.getState().setSessionId("A");
    const { result } = renderHook(({ id }: { id: string }) => useConnectionStack(id), {
      initialProps: { id: "A" },
    });

    await act(async () => { FakeWebSocket.instances[0].simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(1));

    await act(async () => { result.current.reconnect(); });
    expect(result.current.status).toBe("connecting");

    // The abandoned load answers while we are between sockets.
    await act(async () => { historyResolvers[0](historyPayload(["stale baseline"])); });
    expect(useSessionStore.getState().historyLoaded).toBe(true);

    const reconnected = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    await act(async () => { reconnected.simulateOpen(); });
    await act(async () => {
      reconnected.simulateMessage({
        type: "turn_snapshot",
        sessionId: "A",
        messages: [{ role: "assistant", text: "live tail" }],
      });
    });
    // Let any load this open would have issued resolve, so the assertion below
    // fails loudly if one overwrote the snapshot.
    await act(async () => {
      historyResolvers.slice(1).forEach((resolve) => resolve(historyPayload(["stale baseline"])));
    });

    expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["live tail"]);
  });

  /**
   * `loadSessionHistory` raises `historyLoaded` and then keeps going, so a reset
   * landing in that tail lowers the flag while the in-flight guard is still
   * raised. The guard is a ref, and clearing a ref renders nothing — so without
   * an explicit nudge when the load settles, nothing ever re-runs the hydrate
   * effect and the transcript stays queued forever.
   *
   * Lowers the flag directly for the same reason as the test above: a resume of
   * the session already on screen is now a no-op (planning#467).
   */
  it("re-arms hydration when the baseline drops after the flag flips but before the load settles", async () => {
    deferPreviewStatus = true;
    useSessionStore.getState().setSessionId("A");
    renderHook(({ id }: { id: string }) => useConnectionStack(id), {
      initialProps: { id: "A" },
    });

    await act(async () => { FakeWebSocket.instances[0].simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(1));

    // The transcript is applied and the flag is up, but the load is still
    // running — it has the preview-status round trip left.
    await act(async () => { historyResolvers[0](historyPayload(["A baseline"])); });
    expect(useSessionStore.getState().historyLoaded).toBe(true);
    await waitFor(() => expect(previewStatusResolvers).toHaveLength(1));

    // The baseline drops inside that window.
    await act(async () => { useSessionStore.getState().setHistoryLoaded(false); });
    expect(useSessionStore.getState().historyLoaded).toBe(false);

    // The first load finally settles. That must re-arm hydration.
    deferPreviewStatus = false;
    await act(async () => { previewStatusResolvers[0]({ known: true, running: false }); });

    await waitFor(() => expect(historyResolvers).toHaveLength(2));
    await act(async () => { historyResolvers[1](historyPayload(["A baseline"])); });
    expect(useSessionStore.getState().historyLoaded).toBe(true);
  });

  /**
   * The pending-frame flush must not ride along with hydration. An open that
   * correctly skips a redundant history load still has to put a stashed
   * message on the wire.
   */
  it("flushes a stashed message on an open that needs no history load", async () => {
    useSessionStore.getState().setSessionId("A");
    const { result } = renderHook(({ id }: { id: string }) => useConnectionStack(id), {
      initialProps: { id: "A" },
    });

    await act(async () => { FakeWebSocket.instances[0].simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(1));
    await act(async () => { result.current.reconnect(); });
    // The abandoned load answers between sockets, so the next open is already
    // baselined and issues no load of its own.
    await act(async () => { historyResolvers[0](historyPayload(["baseline"])); });
    expect(useSessionStore.getState().historyLoaded).toBe(true);

    useSessionStore.getState().setPendingWsMessage({ type: "send_message", text: "first message" });
    const reconnected = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    await act(async () => { reconnected.simulateOpen(); });

    expect(reconnected.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "send_message", text: "first message", sessionId: "A" }),
    );
    expect(useSessionStore.getState().pendingWsMessage).toBeUndefined();
  });

  /**
   * An ordinary switch from an open socket must issue exactly one load for the
   * incoming session. `status` is React state, so the render that changes the
   * socket URL still carries the OUTGOING socket's `"open"` — and hydration now
   * keys on `historyLoaded`, which `resumeSessionInternal` lowers in that same
   * render. `useWebSocket` reporting `"connecting"` for a URL it has not opened
   * yet is what keeps that stale render from starting a doomed second load (and
   * a second round of `onSessionConnect` hydration with it).
   */
  it("issues exactly one history load for an ordinary switch from an open socket", async () => {
    useSessionStore.getState().setSessionId("A");
    const { rerender } = renderHook(({ id }: { id: string }) => useConnectionStack(id), {
      initialProps: { id: "A" },
    });

    await act(async () => { FakeWebSocket.instances[0].simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(1));
    await act(async () => { historyResolvers[0](historyPayload(["A baseline"])); });

    await act(async () => {
      resumeSessionInternal("B");
      rerender({ id: "B" });
    });
    // The stale-"open" render must not have started anything.
    expect(historyResolvers).toHaveLength(1);

    const socketB = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    await act(async () => { socketB.simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(2));

    // Settle B's load and confirm no third request follows it.
    await act(async () => { historyResolvers[1](historyPayload(["B baseline"])); });
    expect(historyResolvers).toHaveLength(2);
  });

  /**
   * The abandoned load settles AFTER its replacement has already started. A
   * superseded `loadSessionHistory` resolves normally rather than throwing, so
   * an attempt that does not check whether it is still the newest would clear
   * the running load's guard and nudge — starting a third load that supersedes
   * the second, whose own late settle repeats it. That is an unbounded fetch
   * loop, and it also re-runs `onSessionConnect` for a dead socket generation.
   */
  it("ignores an abandoned load that settles after its replacement started", async () => {
    useSessionStore.getState().setSessionId("A");
    const connected: string[] = [];
    const { result } = renderHook(({ id }: { id: string }) => {
      const ws = useSessionWebSocket(id);
      useConnectionSync({
        status: ws.status,
        send: ws.send,
        onSessionConnect: (sid) => { connected.push(sid); },
      });
      return ws;
    }, { initialProps: { id: "A" } });

    await act(async () => { FakeWebSocket.instances[0].simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(1));

    // Reconnect, and let the replacement socket start its own load while the
    // first response is still outstanding.
    await act(async () => { result.current.reconnect(); });
    const reconnected = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    await act(async () => { reconnected.simulateOpen(); });
    await waitFor(() => expect(historyResolvers).toHaveLength(2));

    // The abandoned first response lands last.
    await act(async () => { historyResolvers[0](historyPayload(["stale"])); });
    expect(historyResolvers).toHaveLength(2);

    await act(async () => { historyResolvers[1](historyPayload(["current"])); });
    expect(historyResolvers).toHaveLength(2);
    expect(useSessionStore.getState().historyLoaded).toBe(true);
    expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["current"]);
    // Exactly one live attempt reached the session-hydration callback.
    expect(connected).toEqual(["A"]);
  });
});
