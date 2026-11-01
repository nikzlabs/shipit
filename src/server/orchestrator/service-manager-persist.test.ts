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

  function makeManager(compose: string, opts: { dockerDesktop?: boolean | Error } = {}) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-persist-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), compose);
    const scratchDir = path.join(tmpDir, "scratch");
    // Every daemon-side path ShipIt asked for, and every time it asked Docker which daemon it is.
    const translated: string[] = [];
    let workspaceLookups = 0;
    let desktopChecks = 0;
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
      resolveWorkspaceDevice: () => {
        workspaceLookups++;
        return Promise.resolve(`/daemon${workspaceDir}`);
      },
      isDockerDesktop: () => {
        desktopChecks++;
        const answer = opts.dockerDesktop ?? false;
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      composeRunner: async () => {},
      composeQuery: async () => "",
      pollIntervalMs: 0,
    });
    const readSnapshot = (service: string): SnapshotDoc =>
      parseYaml(recordedSnapshot(workspaceDir, service)) as SnapshotDoc;
    return {
      mgr, scratchDir, translated, readSnapshot,
      workspaceLookups: () => workspaceLookups,
      desktopChecks: () => desktopChecks,
    };
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

  // Docker Desktop mounts this form too, so nothing asks Docker which daemon it is (docs/317).
  it("mounts all of /persist from the workspace volume, where no daemon path is needed", async () => {
    const { mgr, scratchDir, translated, desktopChecks, readSnapshot } = makeManager(
      "services:\n  api:\n    image: x\n    x-shipit-preview: manual\n    volumes: ['persist:/persist']\n",
      { dockerDesktop: true },
    );
    await mgr.start();
    await mgr.startService("api");

    expect(translated).toEqual([]);
    expect(desktopChecks()).toBe(0);
    const doc = readSnapshot("api");
    expect(doc.services.api.volumes).toEqual([{
      type: "volume", source: "shipit-workspace", target: "/persist",
      volume: { nocopy: true, subpath: "sessions/test-session/scratch" },
    }]);
    expect(doc.volumes?.persist).toBeUndefined();
    expect(fs.statSync(scratchDir).isDirectory()).toBe(true);
    await mgr.stop();
  });

  it.each([
    ["a /persist subdirectory", API, "ShipIt cannot mount `persist/verseshot` on Docker Desktop"],
    [
      "a workspace subdirectory",
      "services:\n  api:\n    image: x\n    x-shipit-preview: manual\n    volumes: ['./backend:/app']\n",
      "ShipIt cannot mount `./backend` on Docker Desktop",
    ],
  ])("refuses %s on Docker Desktop before it prepares or looks up anything", async (_label, compose, refusal) => {
    const { mgr, scratchDir, translated, workspaceLookups } = makeManager(compose, { dockerDesktop: true });
    await mgr.start();

    await expect(mgr.startService("api")).rejects.toThrow(refusal);
    expect(mgr.projectComposeFailure).toEqual({ kind: "refused", message: expect.stringContaining(refusal) });
    expect(translated).toEqual([]);
    expect(workspaceLookups()).toBe(0);
    expect(fs.existsSync(scratchDir)).toBe(false);
    await mgr.stop();
  });

  it("fails the start, rather than guess, while Docker cannot say whether it is Docker Desktop", async () => {
    const { mgr, translated, desktopChecks } = makeManager(API, { dockerDesktop: new Error("connect ECONNREFUSED") });
    await mgr.start();

    await expect(mgr.startService("api")).rejects.toThrow("connect ECONNREFUSED");
    expect(mgr.projectComposeFailure?.message).toBe("connect ECONNREFUSED");
    expect(translated).toEqual([]);
    expect(desktopChecks()).toBe(1);
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
