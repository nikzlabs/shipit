import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { recordedOverride, recordedSnapshot, recordedStartFiles, testServiceManager } from "./compose-test-helpers.js";
import type { PluginComposeService } from "./plugin-compose.js";

const MANUAL_WEB =
  "services:\n" +
  "  web:\n" +
  "    image: node:20\n" +
  "    x-shipit-preview: manual\n" +
  "    volumes: ['.:/app']\n";

interface ModelDoc {
  services: Record<string, { volumes?: (string | { target?: string })[] }>;
  volumes?: Record<string, { driver_opts?: Record<string, string> }>;
}

describe("ServiceManager start files follow a compose edit (#2426)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function makeManager(
    resolveDevice: () => Promise<string> = async () => "/var/lib/docker/volumes/shipit-ws/_data/sessions/test-session/workspace",
  ) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-refresh-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const composePath = path.join(workspaceDir, "docker-compose.yml");
    fs.writeFileSync(composePath, MANUAL_WEB);

    const ups: string[][] = [];
    const mgr = testServiceManager({
      sessionId: "test-session",
      workspaceDir,
      serviceEnvDir: path.join(tmpDir, "service-env"),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      workspaceVolume: "shipit-ws",
      workspaceSubpath: "sessions/test-session/workspace",
      resolveWorkspaceDevice: resolveDevice,
      composeRunner: async (args: string[]) => {
        if (args.includes("up")) ups.push(args);
      },
      composeQuery: async () => "",
      pollIntervalMs: 0,
    });
    const readSnapshot = (): ModelDoc => parseYaml(recordedSnapshot(workspaceDir, "web")) as ModelDoc;
    const readOverride = (): ModelDoc => parseYaml(recordedOverride(workspaceDir, "web")) as ModelDoc;
    return { mgr, workspaceDir, composePath, readSnapshot, readOverride, ups };
  }

  function targets(doc: ModelDoc, name: string): string[] {
    return (doc.services[name]?.volumes ?? []).map((v) => (typeof v === "string" ? v : v.target ?? ""));
  }

  it("picks up an edited workspace mount on the next service start", async () => {
    const { mgr, composePath, readSnapshot } = makeManager();
    await mgr.start();
    await mgr.startService("web");
    expect(targets(readSnapshot(), "web")).toContain("/app");

    fs.writeFileSync(composePath, MANUAL_WEB.replace("'.:/app'", "'./game:/srv'"));
    await mgr.restartService("web");

    expect(targets(readSnapshot(), "web")).toEqual(["/srv"]);
    await mgr.stop();
  });

  it("writes the same files again when the compose file is unchanged", async () => {
    const { mgr, workspaceDir } = makeManager();
    await mgr.start();
    await mgr.startService("web");
    const first = recordedStartFiles(workspaceDir, "web");
    const before = [fs.readFileSync(first.snapshot!, "utf-8"), fs.readFileSync(first.override, "utf-8")];

    await mgr.restartService("web");
    await mgr.startService("web");

    const last = recordedStartFiles(workspaceDir, "web");
    expect(last.override).not.toBe(first.override);
    expect([fs.readFileSync(last.snapshot!, "utf-8"), fs.readFileSync(last.override, "utf-8")]).toEqual(before);
    await mgr.stop();
  });

  it("stops declaring a service the user removed from the compose file", async () => {
    const { mgr, composePath, readSnapshot, readOverride } = makeManager();
    const autoWeb = MANUAL_WEB.replace("manual", "auto");
    fs.writeFileSync(composePath, `${autoWeb}  api:\n    image: node:20\n    x-shipit-preview: auto\n`);
    await mgr.start();
    expect(Object.keys(readSnapshot().services)).toContain("api");
    expect(Object.keys(readOverride().services)).toContain("api");

    fs.writeFileSync(composePath, autoWeb);
    await mgr.reconcile();

    expect(Object.keys(readSnapshot().services)).not.toContain("api");
    expect(Object.keys(readOverride().services)).not.toContain("api");
    await mgr.stop();
  });

  it("carries plugin services through a refresh triggered by a project edit", async () => {
    const { mgr, composePath, readSnapshot, readOverride } = makeManager();
    mgr.setPluginServices([{
      name: "probe",
      sourceName: "probe",
      alias: "probe",
      repo: "tools",
      plugin: "probe",
      preview: "manual",
      port: 4820,
      definition: { image: "node:22-alpine", command: "node server.mjs" },
      credentials: [],
      externalVolumes: [],
      self: false,
    } satisfies PluginComposeService]);
    await mgr.start();
    await mgr.startService("web");
    expect(Object.keys(readOverride().services)).toContain("probe");

    fs.writeFileSync(composePath, MANUAL_WEB.replace("'.:/app'", "'./game:/srv'"));
    await mgr.restartService("web");

    expect(Object.keys(readOverride().services)).toContain("probe");
    expect(targets(readSnapshot(), "web")).toEqual(["/srv"]);
    await mgr.stop();
  });

  it("refuses the up and leaves the recorded start alone when the edit is invalid", async () => {
    const { mgr, workspaceDir, composePath, ups } = makeManager();
    await mgr.start();
    await mgr.startService("web");
    const recorded = recordedStartFiles(workspaceDir, "web");
    const before = [fs.readFileSync(recorded.snapshot!, "utf-8"), fs.readFileSync(recorded.override, "utf-8")];
    ups.length = 0;

    fs.writeFileSync(composePath, MANUAL_WEB.replace("image: node:20", "privileged: true\n    image: node:20"));
    await expect(mgr.restartService("web")).rejects.toThrow();

    expect(ups).toEqual([]);
    expect(recordedStartFiles(workspaceDir, "web")).toEqual(recorded);
    expect([fs.readFileSync(recorded.snapshot!, "utf-8"), fs.readFileSync(recorded.override, "utf-8")]).toEqual(before);
    await mgr.stop();
  });

  it("roots a subdirectory mount's volume at the resolved daemon path of this workspace", async () => {
    const { mgr, composePath, readSnapshot } = makeManager(async () => "/daemon/sessions/test-session/workspace");
    fs.writeFileSync(composePath, MANUAL_WEB.replace("'.:/app'", "'./game:/srv'"));
    await mgr.start();
    await mgr.startService("web");

    const doc = readSnapshot() as {
      services: Record<string, { volumes: unknown[] }>;
      volumes: Record<string, { driver_opts?: Record<string, string> }>;
    };
    expect(doc.services.web.volumes).toEqual([
      { type: "volume", source: "shipit-session-workspace", volume: { subpath: "game" }, target: "/srv" },
    ]);
    expect(doc.volumes["shipit-session-workspace"].driver_opts).toEqual({
      type: "none",
      o: "bind",
      device: "/daemon/sessions/test-session/workspace",
    });
    await mgr.stop();
  });

  it("refuses a subdirectory mount, and only that, when the workspace's daemon path is unknown", async () => {
    const { mgr, composePath, ups } = makeManager(async () => {
      throw new Error("volume inspect failed");
    });
    await mgr.start();
    ups.length = 0;

    fs.writeFileSync(composePath, MANUAL_WEB.replace("'.:/app'", "'./game:/srv'"));
    await expect(mgr.restartService("web")).rejects.toThrow(/could not locate this session's workspace/);

    expect(ups).toEqual([]);
    await mgr.stop();
  });
});
