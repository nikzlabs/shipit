/**
 * #2325 — a service message names its session, and the browser holds only one
 * session's services. A late message from a closing socket must not put another
 * session's names and PORTS into the active session: those ports are routing
 * keys, so a foreign row selected in the preview pane asks this session's
 * manager for a number that belongs somewhere else.
 */

import { describe, it, expect, beforeEach } from "vitest";
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
  usePreviewStore.setState({ services: [] });
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
});
