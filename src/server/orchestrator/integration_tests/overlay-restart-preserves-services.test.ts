import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type Docker from "dockerode";

import { computeInstallDepsHash, hasInstallLifecycleScript } from "../../shared/deps-hash.js";
import { readBasePointerByHash } from "../overlay-base.js";
import {
  publishDepDirOverlayBases,
  type AncestryOracle,
  type DepDirPublishOutcome,
} from "../overlay-publish.js";
import { buildOverlaySpecs, overlayRuntimeKey, type DepDirOverlaySpec } from "../overlay-session.js";
import { applyOverlayDepDirs } from "../service-manager-setup.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { createOverlayVolume, overlayDriverOpts } from "../overlay-volume.js";
import type { ServiceManager } from "../service-manager.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionInfo, LogSource } from "../../shared/types.js";

const SESSION_ID = "abcdef012345-0000-0000-0000-000000000000";
const REPO_URL = "https://github.com/nicolasalt/reward-tag.git";
const DEP_DIRS = ["game/node_modules", "tools/debug/node_modules"];
const WORKER_RUNTIME_KEY = "worker|x64|glibc-2.39|node22";
const INSTALL_COMMANDS = ["npm ci --prefix game", "npm ci --prefix tools/debug"];
const INSTALL_INPUTS = [
  "game/package.json",
  "game/package-lock.json",
  "tools/debug/package.json",
  "tools/debug/package-lock.json",
];

const SESSION = {
  remoteUrl: REPO_URL,
  kind: "repo",
  workspaceDir: "",
} as unknown as SessionInfo;

function makeFakeDocker() {
  const volumes = new Map<string, string>();
  const holders = new Map<string, string[]>();
  const removedContainers: string[] = [];

  const docker = {
    listContainers: async (opts: { filters?: { volume?: string[] } }) => {
      const names = opts.filters?.volume ?? [];
      return names.flatMap((v) => (holders.get(v) ?? []).map((Id) => ({ Id, Names: [`/${Id}`] })));
    },
    getContainer: (id: string) => ({
      remove: async () => {
        removedContainers.push(id);
        for (const [vol, ids] of holders) {
          const left = ids.filter((i) => i !== id);
          if (left.length === 0) holders.delete(vol);
          else holders.set(vol, left);
        }
      },
    }),
    getVolume: (name: string) => ({
      inspect: async () => {
        const o = volumes.get(name);
        if (o === undefined) throw Object.assign(new Error("no such volume"), { statusCode: 404 });
        return { Options: { o } };
      },
      remove: async () => {
        if ((holders.get(name) ?? []).length > 0) {
          throw Object.assign(new Error("volume is in use"), { statusCode: 409 });
        }
        volumes.delete(name);
      },
    }),
    createVolume: async (cfg: { Name: string; DriverOpts?: Record<string, string> }) => {
      // Docker ignores new options when the volume name already exists.
      if (!volumes.has(cfg.Name)) volumes.set(cfg.Name, cfg.DriverOpts?.o ?? "");
    },
  };

  return { docker: docker as unknown as Docker, volumes, holders, removedContainers };
}

function makeRunner(): ContainerSessionRunner {
  const runner = Object.create(ContainerSessionRunner.prototype) as Record<string, unknown>;
  runner.sessionId = SESSION_ID;
  runner.whenWorkerReady = () => Promise.resolve();
  Object.defineProperty(runner, "disposed", { value: false, configurable: true });
  return runner as unknown as ContainerSessionRunner;
}

describe("restart agent × overlay base: services survive a code-only commit", () => {
  let tmpDir: string;
  let stateDir: string;
  let workspaceDir: string;
  let env: NodeJS.ProcessEnv;
  let runtimeKey: string;
  let head: string;
  let commitSeq: number;

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", workspaceDir, ...args], { encoding: "utf8" }).trim();
  }

  function commit(msg: string): string {
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    head = git("rev-parse", "HEAD");
    return head;
  }

  // This fixture only advances the default branch.
  const oracle: AncestryOracle = {
    isAncestor: (a, b) => Promise.resolve(a !== b),
    resolveDefaultBranchCommit: () => Promise.resolve(head),
  };

  async function publishAll(
    installCommands: string[] = INSTALL_COMMANDS,
  ): Promise<DepDirPublishOutcome[]> {
    return publishDepDirOverlayBases(
      {
        session: { ...SESSION, workspaceDir },
        workerUrl: "http://worker",
        installOk: true,
        installCommands,
      },
      {
        stateDir,
        createRepoGit: () => oracle,
        getBareCacheDir: (url) => path.join(tmpDir, "cache", encodeURIComponent(url)),
        env,
        fetchHeadInfo: () => Promise.resolve({ commit: head, runtimeKey: WORKER_RUNTIME_KEY }),
        fetchSnapshot: (_url, depDir) =>
          Promise.resolve(Readable.from([Buffer.from(`${depDir}@${lockfileTag}`)])),
        extract: async (stream, destDir) => {
          const chunks: Buffer[] = [];
          for await (const c of stream) chunks.push(Buffer.from(c));
          fs.writeFileSync(path.join(destDir, "installed"), Buffer.concat(chunks));
        },
        tmpRoot: tmpDir,
      },
    );
  }

  let lockfileTag: string;

  function bumpLockfiles(tag: string): void {
    lockfileTag = tag;
    for (const pkg of ["game", "tools/debug"]) {
      fs.writeFileSync(
        path.join(workspaceDir, pkg, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3, tag }),
      );
    }
  }

  function specsNow(): DepDirOverlaySpec[] {
    return buildOverlaySpecs({
      sessionId: SESSION_ID,
      scope: { repoUrl: REPO_URL, runtimeKey },
      depDirs: DEP_DIRS,
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
      generationForScope: (scopeHash) => readBasePointerByHash(stateDir, scopeHash)?.generation ?? 0,
    });
  }

  async function restartAgent(docker: Docker, specs: DepDirOverlaySpec[]): Promise<boolean> {
    let overlayVolumesRecreated = false;
    for (const spec of specs) {
      const { releasedHolders } = await createOverlayVolume(docker, spec, {}, {
        releaseHolders: true,
        sessionId: SESSION_ID,
      });
      if (releasedHolders.length > 0) overlayVolumesRecreated = true;
    }

    // Keep the dep-dir set unchanged to isolate volume recreation.
    const logs: string[] = [];
    const mgr = {
      setOverlayDepDirs: () => false,
    } as unknown as ServiceManager;
    const containerManager = {
      provisionedOverlayDepDirs: () =>
        specs.map((s) => ({ depDir: s.depDir, volumeName: s.volumeName })),
      dockerClient: docker,
      prepareOverlaySpecs: async () => specs,
      consumeOverlayVolumesRecreated: () => {
        const was = overlayVolumesRecreated;
        overlayVolumesRecreated = false;
        return was;
      },
    } as unknown as SessionContainerManager;

    return applyOverlayDepDirs(makeRunner(), mgr, {
      containerManager,
      session: { ...SESSION, workspaceDir },
      workspaceDir,
      broadcastLog: (_id: string, _src: LogSource, text: string) => logs.push(text),
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-restart-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    env = { OVERLAY_DEP_STORE: "1", SESSION_WORKER_IMAGE_ID: "img1" } as NodeJS.ProcessEnv;
    runtimeKey = overlayRuntimeKey(env);

    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-restart-ws-"));
    execFileSync("git", ["-C", workspaceDir, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", workspaceDir, "config", "user.email", "test@ship-it.ai"]);
    execFileSync("git", ["-C", workspaceDir, "config", "user.name", "test"]);
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), `${DEP_DIRS.map((d) => `${d}/`).join("\n")}\n`);
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      [
        "agent:",
        "  dep-dirs:",
        ...DEP_DIRS.map((d) => `    - ${d}`),
        "  install:",
        ...INSTALL_COMMANDS.map((c) => `    - ${c}`),
        "  install-inputs:",
        ...INSTALL_INPUTS.map((f) => `    - ${f}`),
        "",
      ].join("\n"),
    );
    for (const pkg of ["game", "tools/debug"]) {
      fs.mkdirSync(path.join(workspaceDir, pkg), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, pkg, "package.json"), JSON.stringify({ name: pkg }));
    }
    for (const d of DEP_DIRS) fs.mkdirSync(path.join(workspaceDir, d), { recursive: true });
    bumpLockfiles("v1");
    commitSeq = 0;
    commit("initial");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function codeOnlyCommit(msg: string): string {
    commitSeq++;
    fs.writeFileSync(path.join(workspaceDir, "game", `anim-${commitSeq}.ts`), msg);
    return commit(msg);
  }

  it("the incident repo's install really is content-keyable through the production resolvers", async () => {
    const out = await publishAll();
    expect(out.map((o) => o.outcome)).toEqual(["created", "created"]);
    for (const spec of specsNow()) {
      const marker = readBasePointerByHash(stateDir, spec.scopeHash)?.marker;
      expect(marker?.installCommands).toEqual(INSTALL_COMMANDS);
      expect(typeof marker?.depsHash).toBe("string");
    }
  });

  it("a strictly-newer code-only commit leaves every live Compose holder running", async () => {
    await publishAll();

    const { docker, volumes, holders, removedContainers } = makeFakeDocker();
    const original = specsNow();
    await restartAgent(docker, original);

    holders.set(original[0].volumeName, ["game-1"]);
    holders.set(original[1].volumeName, ["debug-1"]);
    const optsAtCreate = original.map((s) => volumes.get(s.volumeName));

    codeOnlyCommit("swing animations that match the damage patterns");
    expect((await publishAll()).map((o) => o.outcome)).toEqual([
      "lineage-advanced",
      "lineage-advanced",
    ]);

    const afterRestart = specsNow();
    expect(afterRestart.map((s) => s.generation)).toEqual(original.map((s) => s.generation));
    expect(afterRestart.map(overlayDriverOpts)).toEqual(original.map(overlayDriverOpts));

    const reconcileRequested = await restartAgent(docker, afterRestart);

    expect(removedContainers).toEqual([]);
    expect(holders.get(original[0].volumeName)).toEqual(["game-1"]);
    expect(holders.get(original[1].volumeName)).toEqual(["debug-1"]);
    expect(original.map((s) => volumes.get(s.volumeName))).toEqual(optsAtCreate);
    expect(reconcileRequested).toBe(false);
  });

  it("a real dependency change still evicts the holders and asks for a reconcile", async () => {
    await publishAll();

    const { docker, volumes, holders, removedContainers } = makeFakeDocker();
    const original = specsNow();
    await restartAgent(docker, original);
    holders.set(original[0].volumeName, ["game-1"]);
    holders.set(original[1].volumeName, ["debug-1"]);

    bumpLockfiles("v2");
    commit("upgrade react");
    expect((await publishAll()).map((o) => o.outcome)).toEqual(["advanced", "advanced"]);

    const afterRestart = specsNow();
    expect(afterRestart.map((s) => s.generation)).toEqual([2, 2]);

    const reconcileRequested = await restartAgent(docker, afterRestart);

    expect(removedContainers.sort()).toEqual(["debug-1", "game-1"]);
    expect(reconcileRequested).toBe(true);
    expect(afterRestart.map((s) => volumes.get(s.volumeName))).toEqual(
      afterRestart.map(overlayDriverOpts),
    );
  });

  it("a lifecycle script disables the no-rotation path, so those services still get evicted", async () => {
    fs.writeFileSync(
      path.join(workspaceDir, "package.json"),
      JSON.stringify({ name: "root", scripts: { postinstall: "node scripts/build.js" } }),
    );
    // Explicit install-inputs would override the lifecycle-script rule.
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      [
        "agent:",
        "  dep-dirs:",
        ...DEP_DIRS.map((d) => `    - ${d}`),
        "  install:",
        "    - npm ci",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(workspaceDir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3 }),
    );
    commit("add a postinstall build step");

    expect(computeInstallDepsHash(workspaceDir, ["npm ci"], null)).toEqual(expect.any(String));
    expect(hasInstallLifecycleScript(workspaceDir)).toBe(true);

    await publishAll(["npm ci"]);

    const { docker, holders, removedContainers } = makeFakeDocker();
    const original = specsNow();
    await restartAgent(docker, original);
    holders.set(original[0].volumeName, ["game-1"]);
    holders.set(original[1].volumeName, ["debug-1"]);

    codeOnlyCommit("change what the postinstall builds");
    expect((await publishAll(["npm ci"])).map((o) => o.outcome)).toEqual(["advanced", "advanced"]);

    const reconcileRequested = await restartAgent(docker, specsNow());
    expect(removedContainers.sort()).toEqual(["debug-1", "game-1"]);
    expect(reconcileRequested).toBe(true);
  });
});
