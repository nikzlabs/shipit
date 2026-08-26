import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { usePreviewStore } from "./preview-store.js";
import { useSessionStore } from "./session-store.js";
import {
  PREVIEW_TARGET_MEMORY_KEY,
  loadPreviewTargetMemory,
  sanitizePreviewTargetEntry,
  withPreviewTargetEntry,
  MAX_REMEMBERED_TARGETS,
} from "./preview-target-memory.js";
import type { ManagedServiceState } from "./preview-store.js";

/** A compose service row as `service_list` / `service_status` deliver it. */
function svc(
  name: string,
  port: number,
  status: ManagedServiceState["status"] = "running",
): ManagedServiceState {
  return { name, port, status, preview: "auto" };
}

/**
 * The `preview_status` a container runner builds: `port` is the FIRST running
 * preview service, which is exactly the value that used to move under the pane.
 */
function statusFor(...running: ManagedServiceState[]) {
  const ports = running.map((s) => s.port!);
  return {
    running: ports.length > 0,
    port: ports[0] ?? 5173,
    url: `/preview/s/${ports[0] ?? 5173}/`,
    source: "detected" as const,
    detectedPorts: ports,
  };
}

describe("preview target memory (planning#478)", () => {
  beforeEach(() => {
    usePreviewStore.getState().clearPreviewTargetMemory();
    usePreviewStore.getState().clearViewportMemory();
    localStorage.clear();
    usePreviewStore.getState().reset();
    useSessionStore.setState({ sessionId: "session-a" });
  });

  afterEach(() => {
    localStorage.clear();
    useSessionStore.setState({ sessionId: undefined });
  });

  describe("sanitizePreviewTargetEntry", () => {
    it("keeps a service entry and a port-only entry", () => {
      expect(sanitizePreviewTargetEntry({ service: "web", port: 3000 })).toEqual({ service: "web", port: 3000 });
      expect(sanitizePreviewTargetEntry({ port: 5173 })).toEqual({ port: 5173 });
    });

    it("drops entries with no usable port, or a non-string service", () => {
      expect(sanitizePreviewTargetEntry({ service: "web" })).toBeNull();
      expect(sanitizePreviewTargetEntry({ port: 0 })).toBeNull();
      expect(sanitizePreviewTargetEntry({ port: 70_000 })).toBeNull();
      expect(sanitizePreviewTargetEntry({ service: 7, port: 3000 })).toBeNull();
      expect(sanitizePreviewTargetEntry("web")).toBeNull();
      expect(sanitizePreviewTargetEntry(null)).toBeNull();
    });
  });

  describe("withPreviewTargetEntry", () => {
    it("re-inserts on write so eviction is LRU, and deletes on null", () => {
      const map = withPreviewTargetEntry(
        withPreviewTargetEntry({}, "a", { service: "web", port: 3000 }),
        "b",
        { port: 5173 },
      );
      expect(Object.keys(withPreviewTargetEntry(map, "a", { service: "api", port: 4000 }))).toEqual(["b", "a"]);
      expect(withPreviewTargetEntry(map, "a", null)).toEqual({ b: { port: 5173 } });
    });

    it("caps the map, evicting oldest first", () => {
      let map: Record<string, { service?: string; port: number }> = {};
      for (let i = 0; i < MAX_REMEMBERED_TARGETS + 5; i++) {
        map = withPreviewTargetEntry(map, `s${i}`, { port: 3000 + i });
      }
      expect(Object.keys(map)).toHaveLength(MAX_REMEMBERED_TARGETS);
      expect(map.s0).toBeUndefined();
      expect(map[`s${MAX_REMEMBERED_TARGETS + 4}`]).toBeDefined();
    });

    it("loads a truncated, validated map from a tampered blob", () => {
      localStorage.setItem(
        PREVIEW_TARGET_MEMORY_KEY,
        JSON.stringify({ good: { service: "web", port: 3000 }, bad: { service: "x" }, worse: 12 }),
      );
      expect(loadPreviewTargetMemory()).toEqual({ good: { service: "web", port: 3000 } });
    });
  });

  describe("pinning what the pane shows", () => {
    it("pins the service behind the default port, by name", () => {
      const web = svc("web", 3000);
      usePreviewStore.getState().setServices([web, svc("api", 4000, "stopped")]);
      usePreviewStore.getState().setStatus(statusFor(web));

      expect(usePreviewStore.getState().selectedPort).toBe(3000);
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "web",
        port: 3000,
      });
    });

    it("does not pin by port while the service list is still missing", () => {
      usePreviewStore.getState().setStatus(statusFor(svc("web", 3000)));
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toBeUndefined();

      // …and pins by NAME once the list lands.
      usePreviewStore.getState().setServices([svc("web", 3000)]);
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "web",
        port: 3000,
      });
    });

    it("pins from the effective status when preview_status lags service_status", () => {
      // The dogfood case: a `manual` service reports running while
      // `preview_status` still says nothing is up. The pane renders from the
      // synthetic status (`deriveEffectivePreviewStatus`), so the pin must come
      // from the same place or it would name a different port.
      usePreviewStore.getState().setServices([svc("dev", 3000)]);
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "dev",
        port: 3000,
      });
      expect(usePreviewStore.getState().selectedPort).toBe(3000);
    });

    it("pins a Vite preview by port — no service owns it", () => {
      usePreviewStore.getState().setStatus({
        running: true,
        port: 5173,
        url: "http://localhost:5173",
        source: "vite",
        detectedPorts: [],
      });
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({ port: 5173 });
      expect(usePreviewStore.getState().selectedPort).toBe(5173);
    });

    it("remembers nothing without an active session", () => {
      useSessionStore.setState({ sessionId: undefined });
      const web = svc("web", 3000);
      usePreviewStore.getState().setServices([web]);
      usePreviewStore.getState().setStatus(statusFor(web));
      expect(usePreviewStore.getState().previewTargetMemory).toEqual({});
    });
  });

  describe("another service starting or restarting", () => {
    it("does not move the pane when a second service comes up first in the list", () => {
      // `api` sorts ahead of `web` in the compose file, so the server's default
      // port flips to it the moment it is running. The pane must not follow.
      const web = svc("web", 3000);
      usePreviewStore.getState().setServices([svc("api", 4000, "stopped"), web]);
      usePreviewStore.getState().setStatus(statusFor(web));
      expect(usePreviewStore.getState().selectedPort).toBe(3000);

      const api = svc("api", 4000);
      usePreviewStore.getState().updateService(api);
      usePreviewStore.getState().setStatus(statusFor(api, web));

      expect(usePreviewStore.getState().status?.port).toBe(4000);
      expect(usePreviewStore.getState().selectedPort).toBe(3000);
    });

    it("returns to the pinned service after it restarts", () => {
      const web = svc("web", 3000);
      const api = svc("api", 4000);
      usePreviewStore.getState().setServices([api, web]);
      usePreviewStore.getState().setSelectedPort(3000);
      expect(usePreviewStore.getState().selectedPort).toBe(3000);

      // `web` goes down: the pane falls back to what IS running…
      usePreviewStore.getState().updateService(svc("web", 3000, "starting"));
      usePreviewStore.getState().setStatus(statusFor(api));
      expect(usePreviewStore.getState().selectedPort).toBeNull();
      // …without forgetting the choice, which is what used to hand the pane
      // over permanently.
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "web",
        port: 3000,
      });

      usePreviewStore.getState().updateService(web);
      usePreviewStore.getState().setStatus(statusFor(api, web));
      expect(usePreviewStore.getState().selectedPort).toBe(3000);
    });
  });

  describe("session switching", () => {
    it("keeps each session on its own service", () => {
      // Session A is looking at `api`.
      const web = svc("web", 3000);
      const api = svc("api", 4000);
      usePreviewStore.getState().setServices([web, api]);
      usePreviewStore.getState().setStatus(statusFor(web, api));
      usePreviewStore.getState().setSelectedPort(4000);
      usePreviewStore.getState().snapshotSession("session-a");

      useSessionStore.setState({ sessionId: "session-b" });
      usePreviewStore.getState().restoreSession("session-b");
      usePreviewStore.getState().setServices([web]);
      usePreviewStore.getState().setStatus(statusFor(web));
      expect(usePreviewStore.getState().selectedPort).toBe(3000);
      usePreviewStore.getState().snapshotSession("session-b");

      // Back to A. Its container was reclaimed while away, so the services
      // report in one at a time and `web` is up first — the exact sequence that
      // used to leave the pane on `web`.
      useSessionStore.setState({ sessionId: "session-a" });
      usePreviewStore.getState().restoreSession("session-a");
      usePreviewStore.getState().setServices([web, svc("api", 4000, "starting")]);
      usePreviewStore.getState().setStatus(statusFor(web));
      expect(usePreviewStore.getState().selectedPort).toBeNull();

      usePreviewStore.getState().updateService(api);
      usePreviewStore.getState().setStatus(statusFor(web, api));
      expect(usePreviewStore.getState().selectedPort).toBe(4000);
    });

    it("survives a page reload — the memory is the source of truth, not the snapshot", () => {
      const web = svc("web", 3000);
      const api = svc("api", 4000);
      usePreviewStore.getState().setServices([web, api]);
      usePreviewStore.getState().setStatus(statusFor(web, api));
      usePreviewStore.getState().setSelectedPort(4000);
      expect(JSON.parse(localStorage.getItem(PREVIEW_TARGET_MEMORY_KEY)!)).toEqual({
        "session-a": { service: "api", port: 4000 },
      });

      // A reload has no snapshot at all: the memory alone has to answer.
      usePreviewStore.setState({ sessionSnapshots: {} });
      usePreviewStore.getState().restoreSession("session-a");
      usePreviewStore.getState().setServices([web, api]);
      usePreviewStore.getState().setStatus(statusFor(web, api));
      expect(usePreviewStore.getState().selectedPort).toBe(4000);
    });

    it("survives the session-scoped reset", () => {
      const web = svc("web", 3000);
      usePreviewStore.getState().setServices([web]);
      usePreviewStore.getState().setStatus(statusFor(web));
      usePreviewStore.getState().reset();
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "web",
        port: 3000,
      });
    });

    it("is cleared by clearPreviewTargetMemory, in state and in storage", () => {
      const web = svc("web", 3000);
      usePreviewStore.getState().setServices([web]);
      usePreviewStore.getState().setStatus(statusFor(web));
      usePreviewStore.getState().clearPreviewTargetMemory();
      expect(usePreviewStore.getState().previewTargetMemory).toEqual({});
      expect(localStorage.getItem(PREVIEW_TARGET_MEMORY_KEY)).toBe("{}");
    });
  });

  describe("forgetting", () => {
    it("re-pins when the remembered service is gone from the compose file", () => {
      const web = svc("web", 3000);
      const api = svc("api", 4000);
      usePreviewStore.getState().setServices([web, api]);
      usePreviewStore.getState().setSelectedPort(4000);

      // `api` was renamed away; the authoritative list no longer declares it.
      usePreviewStore.getState().setServices([web]);
      usePreviewStore.getState().setStatus(statusFor(web));
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "web",
        port: 3000,
      });
      expect(usePreviewStore.getState().selectedPort).toBe(3000);
    });

    it("keeps the memory through an empty list, which is not authoritative", () => {
      const web = svc("web", 3000);
      const api = svc("api", 4000);
      usePreviewStore.getState().setServices([web, api]);
      usePreviewStore.getState().setSelectedPort(4000);

      usePreviewStore.getState().setServices([]);
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "api",
        port: 4000,
      });
    });

    it("setSelectedPort(null) forgets the choice and re-pins the default", () => {
      const web = svc("web", 3000);
      const api = svc("api", 4000);
      usePreviewStore.getState().setServices([web, api]);
      usePreviewStore.getState().setStatus(statusFor(web, api));
      usePreviewStore.getState().setSelectedPort(4000);

      usePreviewStore.getState().setSelectedPort(null);
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "web",
        port: 3000,
      });
      expect(usePreviewStore.getState().selectedPort).toBe(3000);
    });
  });
});
