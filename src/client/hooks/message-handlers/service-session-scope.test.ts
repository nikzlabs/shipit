/**
 * #2325 — a service message names its session, and the browser holds only one
 * session's services. A late message from a closing socket must not put another
 * session's names and PORTS into the active session: those ports are routing
 * keys, so a foreign row selected in the preview pane asks this session's
 * manager for a number that belongs somewhere else.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { dispatchMessage } from "./index.js";
import type { HandlerContext } from "./types.js";
import type { WsServerMessage } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const list = (sessionId: string, name: string, port: number): WsServerMessage => ({
  type: "service_list",
  sessionId,
  services: [{ name, status: "running", port, preview: "auto" }],
});

beforeEach(() => {
  useSessionStore.getState().reset();
  useSessionStore.setState({ sessionId: "active" });
  usePreviewStore.setState({ services: [], startupSteps: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("service messages are scoped to their session", () => {
  it("applies a service list for the active session", () => {
    dispatchMessage(ctx, list("active", "web", 5173));
    expect(usePreviewStore.getState().services).toEqual([
      { name: "web", status: "running", port: 5173, preview: "auto", error: undefined },
    ]);
  });

  it("drops a service list that belongs to another session", () => {
    dispatchMessage(ctx, list("active", "web", 5173));
    dispatchMessage(ctx, list("other", "probe", 42000));
    expect(usePreviewStore.getState().services.map((s) => s.name)).toEqual(["web"]);
  });

  it("drops a status update that belongs to another session", () => {
    dispatchMessage(ctx, list("active", "web", 5173));
    dispatchMessage(ctx, {
      type: "service_status",
      sessionId: "other",
      name: "probe",
      status: "running",
      port: 42000,
      preview: "auto",
    });
    // `updateService` APPENDS an unknown name, so a foreign status is not merely
    // a wrong status — it invents a row, and its port with it.
    expect(usePreviewStore.getState().services.map((s) => s.name)).toEqual(["web"]);
  });

  it("drops a service list that arrives while no session is active", () => {
    // The window a claim leaves open: `/{slug}/new` resets every store and only
    // sets the new id when the claim RESOLVES, and nothing resets the preview
    // store again afterwards. A message accepted here is one the incoming
    // session then adopts as its own — names, ports and all.
    useSessionStore.setState({ sessionId: undefined });
    dispatchMessage(ctx, list("outgoing", "probe", 42000));
    expect(usePreviewStore.getState().services).toEqual([]);

    // …and the session that is then claimed starts empty, not holding the
    // outgoing session's rows.
    useSessionStore.setState({ sessionId: "claimed" });
    expect(usePreviewStore.getState().services).toEqual([]);
  });

  it("applies a status update for the active session", () => {
    dispatchMessage(ctx, list("active", "web", 5173));
    dispatchMessage(ctx, {
      type: "service_status",
      sessionId: "active",
      name: "web",
      status: "error",
      port: 5173,
      preview: "auto",
      error: "boom",
    });
    expect(usePreviewStore.getState().services[0]).toMatchObject({
      name: "web",
      status: "error",
      error: "boom",
    });
  });

  it("does not clear the next session's startup overlay from a delayed callback", () => {
    // The overlay is cleared 800ms after a service reports `running` — long
    // enough to switch sessions, and the dispatch-time guard cannot see a
    // callback that fires later. Only the callback can re-check.
    vi.useFakeTimers();
    usePreviewStore.setState({
      startupSteps: [{ stepId: "dev_server", status: "running", logLines: [] }],
    });
    dispatchMessage(ctx, {
      type: "service_status",
      sessionId: "active",
      name: "web",
      status: "running",
      port: 5173,
      preview: "auto",
    });

    // The user switches away inside the window.
    useSessionStore.setState({ sessionId: "other" });
    usePreviewStore.setState({
      startupSteps: [{ stepId: "install", status: "running", logLines: [] }],
    });
    vi.advanceTimersByTime(1000);

    expect(usePreviewStore.getState().startupSteps.map((s) => s.stepId)).toEqual(["install"]);
  });
});
