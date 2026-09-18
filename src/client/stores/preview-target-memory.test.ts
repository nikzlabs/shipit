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

function svc(
  name: string,
  port: number,
  status: ManagedServiceState["status"] = "running",
): ManagedServiceState {
  return { name, port, status, preview: "auto" };
}

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

      usePreviewStore.getState().setServices([svc("web", 3000)]);
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "web",
        port: 3000,
      });
    });

    it("pins from the effective status when preview_status lags service_status", () => {

      // synthetic status (`deriveEffectivePreviewStatus`), so the pin must come

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

      usePreviewStore.getState().updateService(svc("web", 3000, "starting"));
      usePreviewStore.getState().setStatus(statusFor(api));
      expect(usePreviewStore.getState().selectedPort).toBe(3000);
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "web",
        port: 3000,
      });

      usePreviewStore.getState().updateService(web);
      usePreviewStore.getState().setStatus(statusFor(api, web));
      expect(usePreviewStore.getState().selectedPort).toBe(3000);
    });
  });

  describe("waiting instead of falling back", () => {
    it("holds a stopped service's port rather than handing the pane to another", () => {
      const web = svc("web", 3000);
      const api = svc("api", 4000);
      usePreviewStore.getState().setServices([web, api]);
      usePreviewStore.getState().setSelectedPort(4000);

      usePreviewStore.getState().updateService(svc("api", 4000, "stopped"));
      usePreviewStore.getState().setStatus(statusFor(web));
      expect(usePreviewStore.getState().selectedPort).toBe(4000);
    });

    it("holds it through an error too", () => {
      const web = svc("web", 3000);
      usePreviewStore.getState().setServices([web, svc("api", 4000)]);
      usePreviewStore.getState().setSelectedPort(4000);

      usePreviewStore.getState().updateService({ ...svc("api", 4000, "error"), error: "exit 1" });
      usePreviewStore.getState().setStatus(statusFor(web));
      expect(usePreviewStore.getState().selectedPort).toBe(4000);
    });

    it("holds the recorded port through a service-list gap", () => {

      const web = svc("web", 3000);
      usePreviewStore.getState().setServices([web, svc("api", 4000)]);
      usePreviewStore.getState().setSelectedPort(4000);

      usePreviewStore.getState().setServices([]);
      usePreviewStore.getState().setStatus(statusFor(web));
      expect(usePreviewStore.getState().selectedPort).toBe(4000);
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "api",
        port: 4000,
      });
    });

    it("falls back only when the remembered service has no port to wait on", () => {

      // to show. It cannot be reached by pinning (which resolves a service FROM

      usePreviewStore.getState().setServices([
        svc("web", 3000),
        { name: "worker", status: "running", preview: "manual" },
      ]);
      usePreviewStore.setState({
        previewTargetMemory: { "session-a": { service: "worker", port: 4000 } },
      });
      usePreviewStore.getState().setStatus(statusFor(svc("web", 3000)));
      expect(usePreviewStore.getState().selectedPort).toBeNull();
    });
  });

  describe("session switching", () => {
    it("keeps each session on its own service", () => {

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

      useSessionStore.setState({ sessionId: "session-a" });
      usePreviewStore.getState().restoreSession("session-a");
      usePreviewStore.getState().setServices([web, svc("api", 4000, "starting")]);
      usePreviewStore.getState().setStatus(statusFor(web));
      // Still A's own service, waiting — never `web`, which is the one that

      expect(usePreviewStore.getState().selectedPort).toBe(4000);

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

      usePreviewStore.getState().setServices([web]);
      usePreviewStore.getState().setStatus(statusFor(web));
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "web",
        port: 3000,
      });
      expect(usePreviewStore.getState().selectedPort).toBe(3000);
    });

    it("keeps the memory AND the port through an empty list, which is not authoritative", () => {
      const web = svc("web", 3000);
      const api = svc("api", 4000);
      usePreviewStore.getState().setServices([web, api]);
      usePreviewStore.getState().setStatus(statusFor(web, api));
      usePreviewStore.getState().setSelectedPort(4000);

      usePreviewStore.getState().setServices([]);
      expect(usePreviewStore.getState().previewTargetMemory["session-a"]).toEqual({
        service: "api",
        port: 4000,
      });

      expect(usePreviewStore.getState().selectedPort).toBe(4000);
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
