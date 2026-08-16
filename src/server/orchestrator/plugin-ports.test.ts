import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PLUGIN_PORT_BAND_START,
  pluginPortsPath,
  resolvePublishedPorts,
} from "./plugin-ports.js";

let sessionDir: string;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-ports-"));
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

describe("resolvePublishedPorts", () => {
  it("uses a service's own port when it is free", () => {
    const ports = resolvePublishedPorts(sessionDir, [{ service: "probe", containerPort: 4820 }]);
    expect(ports.get("probe")).toBe(4820);
  });

  it("keeps the pin when a later commit moves the fragment's port (req 18)", () => {
    resolvePublishedPorts(sessionDir, [{ service: "probe", containerPort: 4820 }]);
    const after = resolvePublishedPorts(sessionDir, [{ service: "probe", containerPort: 5000 }]);
    expect(after.get("probe")).toBe(4820);
  });

  it("persists pins across processes", () => {
    resolvePublishedPorts(sessionDir, [{ service: "probe", containerPort: 4820 }]);
    const stored: unknown = JSON.parse(fs.readFileSync(pluginPortsPath(sessionDir), "utf-8"));
    expect(stored).toEqual({ probe: 4820 });
  });

  it("allocates from the band when two services want the same port", () => {
    const ports = resolvePublishedPorts(sessionDir, [
      { service: "a", containerPort: 8080 },
      { service: "b", containerPort: 8080 },
    ]);
    expect(ports.get("a")).toBe(8080);
    expect(ports.get("b")).toBe(PLUGIN_PORT_BAND_START);
  });

  it("re-allocates a pin the project's own services have taken over", () => {
    resolvePublishedPorts(sessionDir, [{ service: "probe", containerPort: 5173 }]);
    const after = resolvePublishedPorts(
      sessionDir,
      [{ service: "probe", containerPort: 5173 }],
      new Set([5173]),
    );
    // The project's port IS its origin and its container port; only the
    // plugin's is ShipIt's own bookkeeping to move.
    expect(after.get("probe")).toBe(PLUGIN_PORT_BAND_START);
    const stored: unknown = JSON.parse(fs.readFileSync(pluginPortsPath(sessionDir), "utf-8"));
    expect(stored).toEqual({ probe: PLUGIN_PORT_BAND_START });
  });

  it("honours an existing pin before allocating for a new service", () => {
    resolvePublishedPorts(sessionDir, [{ service: "old", containerPort: PLUGIN_PORT_BAND_START }]);
    const after = resolvePublishedPorts(sessionDir, [
      { service: "new", containerPort: 80 },
      { service: "old", containerPort: PLUGIN_PORT_BAND_START },
    ]);
    expect(after.get("old")).toBe(PLUGIN_PORT_BAND_START);
    expect(after.get("new")).toBe(80);
  });

  it("prefers a live assignment over the stored pin (#2325)", () => {
    // The caller is re-checking where the origin actually is, against a
    // collision domain it can see and the earlier round could not.
    resolvePublishedPorts(sessionDir, [{ service: "probe", containerPort: 4820 }]);
    const after = resolvePublishedPorts(sessionDir, [
      { service: "probe", containerPort: 4820, pinned: 4900 },
    ]);
    expect(after.get("probe")).toBe(4900);
    const stored: unknown = JSON.parse(fs.readFileSync(pluginPortsPath(sessionDir), "utf-8"));
    expect(stored).toEqual({ probe: 4900 });
  });

  it("moves a live assignment that lands on a reserved port (#2325)", () => {
    const after = resolvePublishedPorts(
      sessionDir,
      [{ service: "probe", containerPort: 5173, pinned: 5173 }],
      new Set([5173]),
    );
    expect(after.get("probe")).toBe(PLUGIN_PORT_BAND_START);
  });

  it("falls back to the stored pin when the live one is taken (#2325)", () => {
    resolvePublishedPorts(sessionDir, [{ service: "probe", containerPort: 4820 }]);
    const after = resolvePublishedPorts(
      sessionDir,
      [{ service: "probe", containerPort: 4820, pinned: 5173 }],
      new Set([5173]),
    );
    // The origin it had is a better answer than a fresh band number.
    expect(after.get("probe")).toBe(4820);
  });

  it("keeps a dropped import's pin, so re-adding it finds the same origin", () => {
    resolvePublishedPorts(sessionDir, [{ service: "probe", containerPort: 4820 }]);
    resolvePublishedPorts(sessionDir, []);
    const readded = resolvePublishedPorts(sessionDir, [{ service: "probe", containerPort: 9999 }]);
    expect(readded.get("probe")).toBe(4820);
  });

  it("gives a service whose declared port is unusable a band allocation", () => {
    const ports = resolvePublishedPorts(sessionDir, [{ service: "worker", containerPort: 0 }]);
    expect(ports.get("worker")).toBe(PLUGIN_PORT_BAND_START);
  });

  it("does not rewrite the store when nothing changed", () => {
    resolvePublishedPorts(sessionDir, [{ service: "probe", containerPort: 4820 }]);
    const before = fs.statSync(pluginPortsPath(sessionDir)).mtimeMs;
    fs.utimesSync(pluginPortsPath(sessionDir), new Date(0), new Date(0));
    resolvePublishedPorts(sessionDir, [{ service: "probe", containerPort: 4820 }]);
    expect(fs.statSync(pluginPortsPath(sessionDir)).mtimeMs).not.toBe(before);
    expect(fs.statSync(pluginPortsPath(sessionDir)).mtimeMs).toBe(0);
  });

  it("degrades to in-memory allocation when the store is unreadable", () => {
    fs.mkdirSync(pluginPortsPath(sessionDir)); // a directory where the file goes
    const ports = resolvePublishedPorts(sessionDir, [{ service: "probe", containerPort: 4820 }]);
    expect(ports.get("probe")).toBe(4820);
  });
});
