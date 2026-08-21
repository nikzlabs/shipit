/**
 * nikzlabs/shipit#2426 — a `docker-compose.yml` edit reaches the GENERATED
 * override, not just the user's file.
 *
 * `docker compose up` re-reads the project file every time, so a `command:`
 * edit always landed. The generated override did not: it was written by
 * `start()`/`reconcile()` and by nothing else, and compose merges it OVER the
 * user's file. Every field the override derives — a service's `volumes:`, which
 * is where the workspace mount and its nested dep-dir overlays live, `env_file:`
 * from `x-shipit-secrets`, the user's named volumes — therefore kept whatever it
 * held at the last full start, through any number of `shipit service restart`
 * cycles. The only thing that refreshed it was the config-file watcher's
 * `reconcile()`, a best-effort inotify over a bind mount.
 *
 * The re-parse that `withUpInFlight` already ran for validation now feeds the
 * override too. These tests pin what makes that safe: a changed file reaches the
 * override, a service dropped from the file stops being declared, an UNCHANGED
 * file rewrites nothing (compose recreates a container whenever its config
 * differs from what the running one was built with, so a gratuitous rewrite
 * would recreate the stack on every crash retry), and an edit that fails
 * validation still refuses the `up` without disturbing the override.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { ServiceManager } from "./service-manager.js";
import { sessionStateDirForWorkspace } from "./session-state-dir.js";
import { COMPOSE_OVERRIDE_FILE } from "../shared/fs-constants.js";
import type { PluginComposeService } from "./plugin-compose.js";

const MANUAL_WEB =
  "services:\n" +
  "  web:\n" +
  "    image: node:20\n" +
  "    x-shipit-preview: manual\n" +
  "    volumes: ['.:/app']\n";

interface OverrideDoc {
  services: Record<string, { volumes?: (string | { target?: string })[] }>;
}

describe("ServiceManager override refresh on a compose edit (#2426)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function makeManager() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-refresh-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const composePath = path.join(workspaceDir, "docker-compose.yml");
    fs.writeFileSync(composePath, MANUAL_WEB);

    const ups: string[][] = [];
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir,
      serviceEnvDir: path.join(tmpDir, "service-env"),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      workspaceVolume: "shipit-ws",
      composeRunner: async (args: string[]) => {
        if (args.includes("up")) ups.push(args);
      },
      composeQuery: async () => "",
      pollIntervalMs: 0,
    });
    const overridePath = path.join(
      sessionStateDirForWorkspace(workspaceDir),
      COMPOSE_OVERRIDE_FILE,
    );
    const readOverride = (): OverrideDoc => parseYaml(fs.readFileSync(overridePath, "utf-8")) as OverrideDoc;
    return { mgr, composePath, overridePath, readOverride, ups };
  }

  /** The container-side targets service `name` mounts, per the override. */
  function targets(doc: OverrideDoc, name: string): string[] {
    return (doc.services[name]?.volumes ?? []).map((v) => (typeof v === "string" ? v : v.target ?? ""));
  }

  it("picks up an edited workspace mount on the next service start", async () => {
    const { mgr, composePath, readOverride } = makeManager();
    await mgr.start();
    expect(targets(readOverride(), "web")).toContain("/app");

    // The user re-points the service at a subdirectory and restarts it. Before
    // this fix the override kept mounting the workspace root at /app and won
    // the merge, so the edit did nothing.
    fs.writeFileSync(composePath, MANUAL_WEB.replace("'.:/app'", "'./game:/srv'"));
    await mgr.restartService("web");

    expect(targets(readOverride(), "web")).toEqual(["/srv"]);
    await mgr.stop();
  });

  it("does not rewrite the override when the compose file is unchanged", async () => {
    const { mgr, overridePath } = makeManager();
    await mgr.start();
    const before = fs.readFileSync(overridePath, "utf-8");
    const stamped = new Date(Date.now() - 60_000);
    fs.utimesSync(overridePath, stamped, stamped);
    const mtimeBefore = fs.statSync(overridePath).mtimeMs;

    await mgr.restartService("web");
    await mgr.startService("web");

    expect(fs.readFileSync(overridePath, "utf-8")).toBe(before);
    // Byte-identical is not enough — a rewrite still changes the file compose
    // hashes its decision against, so assert nothing wrote at all.
    expect(fs.statSync(overridePath).mtimeMs).toBe(mtimeBefore);
    await mgr.stop();
  });

  it("stops declaring a service the user removed from the compose file", async () => {
    const { mgr, composePath, readOverride } = makeManager();
    fs.writeFileSync(
      composePath,
      `${MANUAL_WEB}  api:\n    image: node:20\n    x-shipit-preview: manual\n`,
    );
    await mgr.start();
    expect(Object.keys(readOverride().services)).toContain("api");

    // A stale override declaring a service the base file no longer defines is
    // not merely untidy: compose fails the whole project load on a service with
    // neither an image nor a build context, so `web` could not start either.
    fs.writeFileSync(composePath, MANUAL_WEB);
    await mgr.restartService("web");

    expect(Object.keys(readOverride().services)).not.toContain("api");
    await mgr.stop();
  });

  /**
   * docs/262 — the override is the ONLY place a plugin service's definition
   * exists, so a refresh that rebuilt it from the project's compose file alone
   * would delete every plugin service from the stack the moment the user edited
   * their own file. Admission stays `start()`'s decision (a plugin refused for a
   * port collision must not be silently re-admitted here either), so the refresh
   * carries the admitted set forward verbatim.
   */
  it("carries plugin services through a refresh triggered by a project edit", async () => {
    const { mgr, composePath, readOverride } = makeManager();
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
    expect(Object.keys(readOverride().services)).toContain("probe");

    fs.writeFileSync(composePath, MANUAL_WEB.replace("'.:/app'", "'./game:/srv'"));
    await mgr.restartService("web");

    expect(Object.keys(readOverride().services)).toContain("probe");
    expect(targets(readOverride(), "web")).toEqual(["/srv"]);
    await mgr.stop();
  });

  it("refuses the up and leaves the override alone when the edit is invalid", async () => {
    const { mgr, composePath, overridePath, ups } = makeManager();
    await mgr.start();
    const before = fs.readFileSync(overridePath, "utf-8");
    ups.length = 0;

    fs.writeFileSync(composePath, MANUAL_WEB.replace("image: node:20", "privileged: true\n    image: node:20"));
    await expect(mgr.restartService("web")).rejects.toThrow();

    expect(ups).toEqual([]);
    expect(fs.readFileSync(overridePath, "utf-8")).toBe(before);
    await mgr.stop();
  });
});
