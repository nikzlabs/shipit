import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { InstallController } from "./install-controller.js";
import type { McpConfigController } from "./mcp-config-controller.js";
import { runtimeKey } from "./install-runtime.js";
import { makeMarker, serializeMarker } from "../shared/install-marker.js";
import { computeInstallDepsHash } from "../shared/deps-hash.js";
import { INSTALL_MARKER_FILE } from "../shared/fs-constants.js";

/**
 * A warm-session claim moves HEAD to the latest default branch and keeps the install marker
 * (docs/288-warm-preview-prestart). The worker must then skip when only source moved, so the
 * pre-started preview stays up, and reinstall when the dependency inputs moved.
 *
 * `pip` is content-keyable, and the reinstall cell spawns it, so it must fail offline and at once.
 */
const COMMANDS = ["pip install -r requirements.txt"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

describe("install marker after a claim moves HEAD", () => {
  let app: FastifyInstance;
  let root: string;
  let workspaceDir: string;
  let markedCommit: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "install-head-move-"));
    workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), `agent:\n  install:\n    - ${COMMANDS[0]}\n`);
    fs.writeFileSync(path.join(workspaceDir, "requirements.txt"), "flask\n");
    fs.writeFileSync(path.join(workspaceDir, "app.py"), "print('v1')\n");
    git(workspaceDir, "init", "-q");
    git(workspaceDir, "add", ".");
    git(workspaceDir, "commit", "-q", "-m", "warm");
    markedCommit = git(workspaceDir, "rev-parse", "HEAD");

    // The marker the warm session's pre-install wrote.
    fs.writeFileSync(
      path.join(stateDir, INSTALL_MARKER_FILE),
      serializeMarker(makeMarker({
        sourceCommit: markedCommit,
        runtimeKey: runtimeKey(),
        installCommands: COMMANDS,
        depsHash: computeInstallDepsHash(workspaceDir, COMMANDS, null),
      }, new Date().toISOString())),
    );

    app = Fastify({ logger: false });
    new InstallController({
      workspaceDir,
      stateDir,
      broadcast: () => {},
      mcpConfig: {} as McpConfigController,
    }).registerRoutes(app);
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const advanceMain = (file: string, content: string): void => {
    fs.writeFileSync(path.join(workspaceDir, file), content);
    git(workspaceDir, "commit", "-q", "-am", `change ${file}`);
    expect(git(workspaceDir, "rev-parse", "HEAD")).not.toBe(markedCommit);
  };

  const post = async (): Promise<unknown> =>
    (await app.inject({ method: "POST", url: "/install", payload: { commands: COMMANDS } })).json();

  it("skips when only source moved", async () => {
    advanceMain("app.py", "print('v2')\n");
    expect(await post()).toEqual({ skipped: true, reason: "marker" });
  });

  it("reinstalls when the dependency inputs moved", async () => {
    advanceMain("requirements.txt", "flask\nrequests\n");
    expect(await post()).toEqual({ started: true });
  });
});
