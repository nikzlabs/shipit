import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InstallController } from "./install-controller.js";
import type { McpConfigController } from "./mcp-config-controller.js";
import { runtimeKey } from "./install-runtime.js";
import { makeMarker, serializeMarker } from "../shared/install-marker.js";
import { computeInstallDepsHash } from "../shared/deps-hash.js";
import { INSTALL_MARKER_FILE } from "../shared/fs-constants.js";

/**
 * The worker's install marker matches on `commit || depsHash`, so a change that leaves the commit
 * alone — the build approvals in `pnpm-workspace.yaml`, or anything else the session wrote — skips
 * the install. For pnpm that is not survivable: the verified base is published UNBUILT and every
 * session runs its own install to build what it approves
 * (docs/276-shared-package-cache-integrity section 5). A pnpm session must require the content hash.
 *
 * The install command is a `pip` one on purpose: it is content-keyable, and the not-skipped cell
 * has to actually spawn it, so it must fail offline and at once.
 */
const COMMANDS = ["pip install -r requirements.txt"];

describe("install marker — pnpm requires the content hash (docs/276 section 5)", () => {
  let app: FastifyInstance;
  let roots: string[];

  beforeEach(() => {
    roots = [];
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  });

  function workspace(packageJson: Record<string, unknown>): { workspaceDir: string; stateDir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-pnpm-marker-"));
    roots.push(root);
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      `agent:\n  install:\n    - ${COMMANDS[0]}\n`,
    );
    fs.writeFileSync(path.join(workspaceDir, "package.json"), JSON.stringify(packageJson));
    fs.writeFileSync(path.join(workspaceDir, "requirements.txt"), "flask\n");

    // A marker for the tree as it stands: same (null) commit, same commands, matching content hash.
    fs.writeFileSync(
      path.join(stateDir, INSTALL_MARKER_FILE),
      serializeMarker(makeMarker({
        sourceCommit: null,
        runtimeKey: runtimeKey(),
        installCommands: COMMANDS,
        depsHash: computeInstallDepsHash(workspaceDir, COMMANDS, null),
      }, new Date().toISOString())),
    );

    new InstallController({
      workspaceDir,
      stateDir,
      broadcast: () => {},
      mcpConfig: {} as McpConfigController,
    }).registerRoutes(app);
    return { workspaceDir, stateDir };
  }

  const post = async (): Promise<unknown> =>
    (await app.inject({ method: "POST", url: "/install", payload: { commands: COMMANDS } })).json();

  it("skips an unchanged pnpm tree — the content hash still matches", async () => {
    workspace({ packageManager: "pnpm@12.4.1" });
    expect(await post()).toEqual({ skipped: true, reason: "marker" });
  });

  it("reinstalls a pnpm tree whose dependency content moved under the same commit", async () => {
    const { workspaceDir } = workspace({ packageManager: "pnpm@12.4.1" });
    fs.writeFileSync(path.join(workspaceDir, "requirements.txt"), "flask\nrequests\n");
    expect(await post()).toEqual({ started: true });
  });

  it("control: the same change on a non-pnpm tree still skips, via the commit path", async () => {
    const { workspaceDir } = workspace({ name: "fixture" });
    fs.writeFileSync(path.join(workspaceDir, "requirements.txt"), "flask\nrequests\n");
    expect(await post()).toEqual({ skipped: true, reason: "marker" });
  });
});
