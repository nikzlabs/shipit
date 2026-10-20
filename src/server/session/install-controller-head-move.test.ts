import { describe, it, expect, afterEach } from "vitest";
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
 * pre-started preview stays up, and reinstall when something the install reads moved.
 *
 * `pip` is content-keyable. Each requirement is a local path that does not exist, so an install
 * that does run fails at once and offline.
 */
const COMMANDS = ["pip install -r requirements.txt"];
const REQUIREMENTS = "./missing-local-package\n";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

describe("install marker after a claim moves HEAD", () => {
  let app: FastifyInstance | undefined;
  let root: string | undefined;

  afterEach(async () => {
    if (app) {
      // An install that started must end before its workspace is removed.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const status = (await app.inject({ method: "GET", url: "/install/status" })).json() as { running: boolean };
        if (!status.running) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await app.close();
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
    app = undefined;
    root = undefined;
  });

  function setup(opts: { postinstall?: string; installInputs?: string[] } = {}): {
    advanceMain: (file: string, content: string) => void;
    post: () => Promise<unknown>;
  } {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "install-head-move-"));
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const inputs = opts.installInputs ? `  install-inputs: [${opts.installInputs.join(", ")}]\n` : "";
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), `agent:\n  install:\n    - ${COMMANDS[0]}\n${inputs}`);
    fs.writeFileSync(path.join(workspaceDir, "requirements.txt"), REQUIREMENTS);
    fs.writeFileSync(path.join(workspaceDir, "schema.prisma"), "model A {}\n");
    if (opts.postinstall) {
      fs.writeFileSync(
        path.join(workspaceDir, "package.json"),
        JSON.stringify({ name: "fixture", scripts: { postinstall: opts.postinstall } }),
      );
    }
    git(workspaceDir, "init", "-q");
    git(workspaceDir, "add", ".");
    git(workspaceDir, "commit", "-q", "-m", "warm");
    const markedCommit = git(workspaceDir, "rev-parse", "HEAD");

    // The marker the warm session's pre-install wrote.
    fs.writeFileSync(
      path.join(stateDir, INSTALL_MARKER_FILE),
      serializeMarker(makeMarker({
        sourceCommit: markedCommit,
        runtimeKey: runtimeKey(),
        installCommands: COMMANDS,
        depsHash: computeInstallDepsHash(workspaceDir, COMMANDS, opts.installInputs ?? null),
      }, new Date().toISOString())),
    );

    const server = Fastify({ logger: false });
    app = server;
    new InstallController({
      workspaceDir,
      stateDir,
      broadcast: () => {},
      mcpConfig: {} as McpConfigController,
    }).registerRoutes(server);

    return {
      advanceMain: (file, content) => {
        fs.writeFileSync(path.join(workspaceDir, file), content);
        git(workspaceDir, "add", file);
        git(workspaceDir, "commit", "-q", "-m", `change ${file}`);
        expect(git(workspaceDir, "rev-parse", "HEAD")).not.toBe(markedCommit);
      },
      post: async () =>
        (await server.inject({ method: "POST", url: "/install", payload: { commands: COMMANDS } })).json(),
    };
  }

  it("skips when only source moved", async () => {
    const { advanceMain, post } = setup();
    advanceMain("schema.prisma", "model B {}\n");
    expect(await post()).toEqual({ skipped: true, reason: "marker" });
  });

  it("reinstalls when the dependency inputs moved", async () => {
    const { advanceMain, post } = setup();
    advanceMain("requirements.txt", `${REQUIREMENTS}./other-missing-package\n`);
    expect(await post()).toEqual({ started: true });
  });

  it("reinstalls when a lifecycle script may read a file the hash does not cover", async () => {
    const { advanceMain, post } = setup({ postinstall: "prisma generate" });
    advanceMain("schema.prisma", "model B {}\n");
    expect(await post()).toEqual({ started: true });
  });

  it("skips again when install-inputs names what the lifecycle script reads", async () => {
    const { advanceMain, post } = setup({
      postinstall: "prisma generate",
      installInputs: ["requirements.txt", "schema.prisma"],
    });
    advanceMain("README.md", "docs only\n");
    expect(await post()).toEqual({ skipped: true, reason: "marker" });
  });
});
