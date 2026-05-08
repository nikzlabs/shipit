import { describe, it, expect } from "vitest";
import { deriveEffectivePreviewStatus } from "./preview-status.js";
import type { PreviewStatus } from "../components/PreviewFrame.js";
import type { ManagedServiceState } from "../stores/preview-store.js";

describe("deriveEffectivePreviewStatus", () => {
  it("returns preview unchanged when preview.running is true", () => {
    const preview: PreviewStatus = {
      running: true,
      port: 5173,
      url: "http://localhost:5173",
      source: "vite",
    };
    const services: ManagedServiceState[] = [];
    expect(deriveEffectivePreviewStatus(preview, services, "abc")).toBe(preview);
  });

  it("returns preview unchanged when no running services have a port", () => {
    const preview: PreviewStatus = { running: false, port: 0, url: "" };
    const services: ManagedServiceState[] = [
      { name: "dev", status: "stopped", port: 3000, preview: "manual" },
    ];
    expect(deriveEffectivePreviewStatus(preview, services, "abc")).toBe(preview);
  });

  it("returns preview unchanged when running service has no port", () => {
    const preview: PreviewStatus = { running: false, port: 0, url: "" };
    const services: ManagedServiceState[] = [
      { name: "worker", status: "running", preview: "manual" },
    ];
    expect(deriveEffectivePreviewStatus(preview, services, "abc")).toBe(preview);
  });

  it("synthesizes running preview when a manual service is running with a port", () => {
    const preview: PreviewStatus = { running: false, port: 0, url: "" };
    const services: ManagedServiceState[] = [
      { name: "dev", status: "running", port: 3000, preview: "manual" },
    ];
    const result = deriveEffectivePreviewStatus(preview, services, "session-abc");
    expect(result).toEqual({
      running: true,
      port: 3000,
      url: "/preview/session-abc/3000/",
      source: "detected",
      detectedPorts: [3000],
    });
  });

  it("synthesizes running preview from null preview_status", () => {
    const services: ManagedServiceState[] = [
      { name: "dev", status: "running", port: 3000, preview: "manual" },
    ];
    const result = deriveEffectivePreviewStatus(null, services, "session-abc");
    expect(result?.running).toBe(true);
    expect(result?.port).toBe(3000);
  });

  it("includes all running services with ports in detectedPorts", () => {
    const preview: PreviewStatus = { running: false, port: 0, url: "" };
    const services: ManagedServiceState[] = [
      { name: "web", status: "running", port: 5173, preview: "auto" },
      { name: "api", status: "running", port: 8080, preview: "auto" },
      { name: "worker", status: "stopped", port: 9000, preview: "manual" },
    ];
    const result = deriveEffectivePreviewStatus(preview, services, "session-abc");
    expect(result?.detectedPorts).toEqual([5173, 8080]);
    // Picks the first running service's port as the primary
    expect(result?.port).toBe(5173);
  });

  it("handles missing sessionId gracefully", () => {
    const preview: PreviewStatus = { running: false, port: 0, url: "" };
    const services: ManagedServiceState[] = [
      { name: "dev", status: "running", port: 3000, preview: "manual" },
    ];
    const result = deriveEffectivePreviewStatus(preview, services, null);
    expect(result?.url).toBe("/preview//3000/");
  });
});
