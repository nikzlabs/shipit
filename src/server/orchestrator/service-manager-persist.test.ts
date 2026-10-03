import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { recordedSnapshot, testServiceManager } from "./compose-test-helpers.js";

interface SnapshotDoc {
  services: Record<string, { volumes?: unknown[] }>;
  volumes?: Record<string, { driver_opts?: Record<string, string> }>;
}

describe("ServiceManager mounts the session's /persist into a service (docs/317)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function makeManager(compose: string) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-persist-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), compose);
    const scratchDir = path.join(tmpDir, "scratch");
    const translated: string[] = [];
    const mgr = testServiceManager({
      sessionId: "test-session",
      workspaceDir,
      serviceEnvDir: path.join(tmpDir, "service-env"),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      workspaceVolume: "shipit-ws",
      workspaceSubpath: "sessions/test-session/workspace",
      persistDevicePath: (hostPath) => {
        translated.push(hostPath);
        return Promise.resolve(`/daemon${hostPath}`);
      },
      composeRunner: async () => {},
      composeQuery: async () => "",
      pollIntervalMs: 0,
    });
    const readSnapshot = (service: string): SnapshotDoc =>
      parseYaml(recordedSnapshot(workspaceDir, service)) as SnapshotDoc;
    return { mgr, scratchDir, translated, readSnapshot };
  }

  const API = "services:\n  api:\n    image: node:24-slim\n    x-shipit-preview: manual\n"
    + "    volumes: ['persist/verseshot:/data']\n";

  it("points the volume at this session's scratch directory, the one the agent sees at /persist", async () => {
    const { mgr, scratchDir, translated, readSnapshot } = makeManager(API);
    await mgr.start();
    await mgr.startService("api");

    expect(translated).toEqual([scratchDir]);
    const doc = readSnapshot("api");
    expect(doc.volumes?.persist?.driver_opts).toEqual({ type: "none", o: "bind", device: `/daemon${scratchDir}` });
    expect(doc.services.api.volumes).toEqual([
      { type: "volume", source: "persist", target: "/data", volume: { nocopy: true, subpath: "verseshot" } },
    ]);
    expect(fs.statSync(path.join(scratchDir, "verseshot")).isDirectory()).toBe(true);
    await mgr.stop();
  });

  it("recreates a mounted subdirectory the agent deleted before the service starts again", async () => {
    const { mgr, scratchDir } = makeManager(API);
    await mgr.start();
    await mgr.startService("api");
    fs.rmSync(path.join(scratchDir, "verseshot"), { recursive: true });

    await mgr.restartService("api");

    expect(fs.statSync(path.join(scratchDir, "verseshot")).isDirectory()).toBe(true);
    await mgr.stop();
  });

  it("touches nothing under /persist for a project that does not use it", async () => {
    const { mgr, scratchDir, translated, readSnapshot } = makeManager(
      "services:\n  web:\n    image: x\n    x-shipit-preview: manual\n    volumes: ['.:/app']\n",
    );
    await mgr.start();
    await mgr.startService("web");
    expect(translated).toEqual([]);
    expect(fs.existsSync(scratchDir)).toBe(false);
    expect(readSnapshot("web").volumes?.persist).toBeUndefined();
    await mgr.stop();
  });
});
