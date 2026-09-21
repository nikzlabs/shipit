import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  publishDepDirOverlayBases,
  formatOverlayMeasurement,
  type OverlayPublishDeps,
  type AncestryOracle,
} from "./overlay-publish.js";
import { extractTarStream } from "./overlay-snapshot.js";
import { publishBase, readBasePointer, type OverlayScope } from "./overlay-base.js";
import { overlayRuntimeKey, PNPM_VERIFIED_NAMESPACE } from "./overlay-session.js";
import { overlayScopeHash } from "./overlay-volume.js";
import type { PnpmBaseBuildOutcome, PnpmBaseBuildRequest } from "./pnpm-base-builder.js";

const REPO_URL = "https://github.com/acme/widgets.git";
const HEAD = "c0ffee".padEnd(40, "0");

function makeWorkspace(depDirs: string[], opts: { ignore?: boolean; shipitDepDirs?: string[] } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-pub-ws-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  if (opts.ignore !== false) {
    fs.writeFileSync(path.join(dir, ".gitignore"), `${depDirs.map((d) => `${d}/`).join("\n")}\n`);
  }
  for (const d of depDirs) fs.mkdirSync(path.join(dir, d), { recursive: true });
  if (opts.shipitDepDirs) {
    fs.writeFileSync(
      path.join(dir, "shipit.yaml"),
      `agent:\n  dep-dirs:\n${opts.shipitDepDirs.map((d) => `    - ${d}`).join("\n")}\n`,
    );
  }
  return dir;
}

describe("overlay-publish: publishDepDirOverlayBases", () => {
  let tmpDir: string;
  let stateDir: string;
  let workspaceDir: string;
  let env: NodeJS.ProcessEnv;
  let runtimeKey: string;

  const oracle: AncestryOracle = {
    isAncestor: (a, b) => Promise.resolve(a !== b),
    resolveDefaultBranchCommit: () => Promise.resolve(HEAD),
  };

  function depsWith(over: Partial<OverlayPublishDeps> = {}): OverlayPublishDeps {
    return {
      stateDir,
      createRepoGit: () => oracle,
      getBareCacheDir: (url: string) => path.join(tmpDir, "cache", encodeURIComponent(url)),
      env,
      fetchHeadInfo: () => Promise.resolve({ commit: HEAD, runtimeKey: "img|x64|glibc|node24" }),
      fetchSnapshot: (_url, depDir) => Promise.resolve(Readable.from([Buffer.from(depDir)])),
      extract: async (stream, destDir) => {
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(Buffer.from(c));
        fs.writeFileSync(path.join(destDir, "content"), Buffer.concat(chunks));
      },
      tmpRoot: tmpDir,
      ...over,
    };
  }

  function baseContentFor(depDir: string): string | null {
    const ptr = pointerFor(depDir);
    if (!ptr) return null;
    const f = path.join(ptr.baseDir, "content");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  }

  function pointerFor(depDir: string) {
    const scope: OverlayScope = { repoUrl: REPO_URL, runtimeKey, depDir };
    return readBasePointer(stateDir, scope);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-pub-state-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    env = { OVERLAY_DEP_STORE: "1", SESSION_WORKER_IMAGE_ID: "img1" } as NodeJS.ProcessEnv;
    runtimeKey = overlayRuntimeKey(env);
    workspaceDir = makeWorkspace(["node_modules"]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("publishes the default dep dir (node_modules) as a created base", async () => {
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith(),
    );
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 }]);
    expect(pointerFor("node_modules")).toMatchObject({ commit: HEAD, depth: 1 });
    expect(baseContentFor("node_modules")).toBe("node_modules");
  });

  it("records the publisher's marker stamp on the pointer when installCommands are provided", async () => {
    const out = await publishDepDirOverlayBases(
      {
        session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir },
        workerUrl: "http://w",
        installOk: true,
        installCommands: ["npm install"],
      },
      depsWith(),
    );
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 }]);
    expect(pointerFor("node_modules")?.marker).toEqual({
      runtimeKey: "img|x64|glibc|node24",
      installCommands: ["npm install"],
      depsHash: null,
    });
  });

  it("propagates the dependency content key (depsHash) into the pointer marker (docs/198)", async () => {
    fs.writeFileSync(path.join(workspaceDir, "package.json"), '{"name":"x"}');
    fs.writeFileSync(path.join(workspaceDir, "package-lock.json"), '{"lockfileVersion":3}');
    const out = await publishDepDirOverlayBases(
      {
        session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir },
        workerUrl: "http://w",
        installOk: true,
        installCommands: ["npm install"],
      },
      depsWith(),
    );
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 }]);
    const marker = pointerFor("node_modules")?.marker;
    expect(marker?.runtimeKey).toBe("img|x64|glibc|node24");
    expect(marker?.installCommands).toEqual(["npm install"]);
    expect(typeof marker?.depsHash).toBe("string");
    expect(marker?.depsHash).toHaveLength(64);
  });

  it("disables content-keying (null depsHash) when the install isn't a recognized pure dep install (docs/198)", async () => {
    fs.writeFileSync(path.join(workspaceDir, "package.json"), '{"name":"x"}');
    fs.writeFileSync(path.join(workspaceDir, "package-lock.json"), '{"lockfileVersion":3}');
    const out = await publishDepDirOverlayBases(
      {
        session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir },
        workerUrl: "http://w",
        installOk: true,
        installCommands: ["npm install", "npm run codegen"],
      },
      depsWith(),
    );
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 }]);
    expect(pointerFor("node_modules")?.marker?.depsHash).toBeNull();
  });

  it("omits the pointer marker when the worker reports no runtime key", async () => {
    const out = await publishDepDirOverlayBases(
      {
        session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir },
        workerUrl: "http://w",
        installOk: true,
        installCommands: ["npm install"],
      },
      depsWith({ fetchHeadInfo: () => Promise.resolve({ commit: HEAD, runtimeKey: null }) }),
    );
    expect(out[0].outcome).toBe("created");
    expect(pointerFor("node_modules")?.marker).toBeUndefined();
  });

  it("publishes each declared dep dir into its OWN scope (cross-dir isolation)", async () => {
    workspaceDir = makeWorkspace(["node_modules", "packages/app/node_modules"], {
      shipitDepDirs: ["node_modules", "packages/app/node_modules"],
    });
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith(),
    );
    expect(out).toEqual([
      { depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 },
      { depDir: "packages/app/node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 },
    ]);
    expect(baseContentFor("node_modules")).toBe("node_modules");
    expect(baseContentFor("packages/app/node_modules")).toBe("packages/app/node_modules");
    expect(overlayScopeHash(REPO_URL, runtimeKey, "node_modules")).not.toBe(
      overlayScopeHash(REPO_URL, runtimeKey, "packages/app/node_modules"),
    );
  });

  it("propagates the climbing overlay depth on an advance (the depth-cap signal)", async () => {
    const c1 = "c1".padEnd(40, "0");
    const c2 = "c2".padEnd(40, "0");
    let head = c1;
    const oracle2: AncestryOracle = {
      isAncestor: (a, b) => Promise.resolve(a === c1 && b === c2),
      resolveDefaultBranchCommit: () => Promise.resolve(head),
    };
    const deps = depsWith({ createRepoGit: () => oracle2, fetchHeadInfo: () => Promise.resolve({ commit: head, runtimeKey: "img|x64|glibc|node24" }) });
    const session = { remoteUrl: REPO_URL, kind: undefined, workspaceDir };

    const first = await publishDepDirOverlayBases({ session, workerUrl: "http://w", installOk: true }, deps);
    expect(first).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 }]);

    head = c2;
    const second = await publishDepDirOverlayBases({ session, workerUrl: "http://w", installOk: true }, deps);
    expect(second).toEqual([{ depDir: "node_modules", outcome: "advanced", depth: 2, generation: 2, attempts: 1 }]);
  });

  it("no-ops when the kill switch is set (OVERLAY_DEP_STORE=0)", async () => {
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith({ env: { OVERLAY_DEP_STORE: "0" } as NodeJS.ProcessEnv }),
    );
    expect(out).toEqual([]);
    expect(pointerFor("node_modules")).toBeNull();
  });

  it("no-ops for an ineligible session (no remoteUrl)", async () => {
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: "", kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith(),
    );
    expect(out).toEqual([]);
  });

  it("no-ops for an ops session", async () => {
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: "ops", workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith(),
    );
    expect(out).toEqual([]);
  });

  it("no-ops for a pnpm repo (no base published), while an npm repo still publishes", async () => {
    fs.writeFileSync(path.join(workspaceDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith(),
    );
    expect(out).toEqual([]);
    expect(pointerFor("node_modules")).toBeNull();
    expect(baseContentFor("node_modules")).toBeNull();

    const npmWs = makeWorkspace(["node_modules"]);
    try {
      const npmOut = await publishDepDirOverlayBases(
        { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir: npmWs }, workerUrl: "http://w", installOk: true },
        depsWith(),
      );
      expect(npmOut).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 }]);
    } finally {
      fs.rmSync(npmWs, { recursive: true, force: true });
    }
  });

  it("skips (no base) when the install failed", async () => {
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: false },
      depsWith(),
    );
    expect(out).toEqual([{ depDir: "node_modules", outcome: "skipped-ineligible" }]);
    expect(pointerFor("node_modules")).toBeNull();
  });

  it("skips when the worker head-commit can't be resolved", async () => {
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith({ fetchHeadInfo: () => Promise.resolve(null) }),
    );
    expect(out).toEqual([{ depDir: "node_modules", outcome: "skipped-ineligible" }]);
    expect(pointerFor("node_modules")).toBeNull();
  });

  it("declines to publish when the source is not the remote default branch", async () => {
    const other: AncestryOracle = {
      isAncestor: () => Promise.resolve(false),
      resolveDefaultBranchCommit: () => Promise.resolve("deadbeef".padEnd(40, "0")),
    };
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith({ createRepoGit: () => other }),
    );
    expect(out).toEqual([
      { depDir: "node_modules", outcome: "skipped-ineligible", depth: undefined, generation: undefined, attempts: 1 },
    ]);
    expect(pointerFor("node_modules")).toBeNull();
  });

  it("drops a dep dir that is tracked source (not git-ignored), keeping the ignored one", async () => {
    workspaceDir = makeWorkspace(["node_modules", "src/vendored"], {
      ignore: false,
      shipitDepDirs: ["node_modules", "src/vendored"],
    });
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), "node_modules/\n");
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith(),
    );
    expect(out).toEqual([
      { depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 },
      { depDir: "src/vendored", outcome: "dropped", dropReason: "not-git-ignored" },
    ]);
    expect(baseContentFor("node_modules")).toBe("node_modules");
    expect(baseContentFor("src/vendored")).toBeNull();
  });

  // The incident: `.tools/` is ignored so no clone has it, and requiring the parent dropped the
  // dep dir silently — the measurement line simply omitted it (docs/183 FINDINGS, 2026-09-15).
  it("publishes a dep dir whose parent is itself git-ignored and absent on the clone", async () => {
    workspaceDir = makeWorkspace(["node_modules"], { shipitDepDirs: ["node_modules", ".tools/blender"] });
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), "node_modules/\n.tools/\n");
    // `.tools` must NOT exist: creating it is what made the old parent-exists check accept this.
    expect(fs.existsSync(path.join(workspaceDir, ".tools"))).toBe(false);
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith(),
    );
    expect(out).toEqual([
      { depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 },
      { depDir: ".tools/blender", outcome: "created", depth: 1, generation: 1, attempts: 1 },
    ]);
    expect(baseContentFor(".tools/blender")).toBe(".tools/blender");
  });

  it("reports a dropped dep dir even when nothing is left to publish", async () => {
    workspaceDir = makeWorkspace([], { ignore: false, shipitDepDirs: ["src/vendored"] });
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), "node_modules/\n");
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith(),
    );
    expect(out).toEqual([{ depDir: "src/vendored", outcome: "dropped", dropReason: "not-git-ignored" }]);
  });

  it("declines to publish an empty snapshot (no base, no pointer)", async () => {
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith({
        extract: async (stream) => { for await (const _ of stream) { /* drain */ } },
      }),
    );
    expect(out).toEqual([{ depDir: "node_modules", outcome: "skipped-empty", attempts: 1 }]);
    expect(pointerFor("node_modules")).toBeNull();
    expect(baseContentFor("node_modules")).toBeNull();
  });

  it("records a per-dir error without aborting the other dirs", async () => {
    workspaceDir = makeWorkspace(["node_modules", "packages/app/node_modules"], {
      shipitDepDirs: ["node_modules", "packages/app/node_modules"],
    });
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith({
        fetchSnapshot: (_url, depDir) =>
          depDir === "node_modules"
            ? Promise.reject(new Error("boom"))
            : Promise.resolve(Readable.from([Buffer.from(depDir)])),
      }),
    );
    expect(out[0]).toMatchObject({ depDir: "node_modules", outcome: "error" });
    expect(out[1]).toEqual({ depDir: "packages/app/node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 });
    expect(pointerFor("node_modules")).toBeNull();
    expect(baseContentFor("packages/app/node_modules")).toBe("packages/app/node_modules");
  });

  it("threads the abort signal into the worker pull and head fetch", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    await publishDepDirOverlayBases(
      {
        session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir },
        workerUrl: "http://w",
        installOk: true,
        signal: controller.signal,
      },
      depsWith({
        fetchHeadInfo: (_url, signal) => {
          seen.push(signal);
          return Promise.resolve({ commit: HEAD, runtimeKey: "img|x64|glibc|node24" });
        },
        fetchSnapshot: (_url, depDir, signal) => {
          seen.push(signal);
          return Promise.resolve(Readable.from([Buffer.from(depDir)]));
        },
      }),
    );
    expect(seen).toEqual([controller.signal, controller.signal]);
  });

  it("records an error (never throws) when the pull dies mid-stream", async () => {
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith({
        fetchSnapshot: () => {
          const s = new Readable({ read() {} });
          s.push(Buffer.alloc(4096));
          setTimeout(() => s.destroy(new Error("terminated")), 5);
          return Promise.resolve(s);
        },
        extract: extractTarStream,
      }),
    );
    expect(out).toEqual([
      { depDir: "node_modules", outcome: "error", error: expect.stringContaining("terminated"), attempts: 2 },
    ]);
    expect(pointerFor("node_modules")).toBeNull();
  });

  it("retries a raced snapshot once, and publishes the clean attempt", async () => {
    const attempts: string[] = [];
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith({
        fetchSnapshot: (_url, depDir) => {
          attempts.push(depDir);
          if (attempts.length === 1) {
            return Promise.reject(new Error(
              "tar exited with code 1 while snapshotting /workspace/node_modules: tar: .: file changed as we read it",
            ));
          }
          return Promise.resolve(Readable.from([Buffer.from(depDir)]));
        },
      }),
    );
    expect(attempts).toEqual(["node_modules", "node_modules"]);
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 2 }]);
    expect(baseContentFor("node_modules")).toBe("node_modules");
  });

  it("gives up after the retry rather than publishing a dep dir that never read clean", async () => {
    const attempts: string[] = [];
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith({
        fetchSnapshot: (_url, depDir) => {
          attempts.push(depDir);
          return Promise.reject(new Error("tar exited with code 1: tar: .: file changed as we read it"));
        },
      }),
    );
    expect(attempts).toHaveLength(2);
    expect(out).toEqual([
      {
        depDir: "node_modules",
        outcome: "error",
        error: expect.stringContaining("file changed as we read it"),
        attempts: 2,
      },
    ]);
    expect(pointerFor("node_modules")).toBeNull();
  });

  it("does NOT retry a pull the session's disposal aborted", async () => {
    const controller = new AbortController();
    const attempts: string[] = [];
    const out = await publishDepDirOverlayBases(
      {
        session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir },
        workerUrl: "http://w",
        installOk: true,
        signal: controller.signal,
      },
      depsWith({
        fetchSnapshot: () => {
          attempts.push("pull");
          controller.abort(new Error("session runner disposed"));
          return Promise.reject(new Error("terminated"));
        },
      }),
    );
    expect(attempts).toHaveLength(1);
    expect(out).toEqual([
      { depDir: "node_modules", outcome: "error", error: expect.stringContaining("terminated"), attempts: 1 },
    ]);
  });

  it("does not mix a failed attempt's partial tree into the retry's", async () => {
    let call = 0;
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith({
        extract: async (stream, destDir) => {
          for await (const _ of stream) { /* drain */ }
          fs.mkdirSync(destDir, { recursive: true });
          if (++call === 1) {
            fs.writeFileSync(path.join(destDir, "half-written"), "from the raced attempt");
            throw new Error("tar -x exited with code 1");
          }
          fs.writeFileSync(path.join(destDir, "content"), "clean");
        },
      }),
    );
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 2 }]);
    const ptr = pointerFor("node_modules");
    expect(ptr).not.toBeNull();
    expect(fs.readdirSync(ptr?.baseDir ?? "").sort()).toEqual(["content"]);
    expect(baseContentFor("node_modules")).toBe("clean");
  });

  it("stops pulling remaining dep dirs once the signal aborts", async () => {
    workspaceDir = makeWorkspace(["node_modules", "packages/app/node_modules"], {
      shipitDepDirs: ["node_modules", "packages/app/node_modules"],
    });
    const controller = new AbortController();
    const pulled: string[] = [];
    const out = await publishDepDirOverlayBases(
      {
        session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir },
        workerUrl: "http://w",
        installOk: true,
        signal: controller.signal,
      },
      depsWith({
        fetchSnapshot: (_url, depDir) => {
          pulled.push(depDir);
          controller.abort(new Error("session runner disposed"));
          return Promise.resolve(Readable.from([Buffer.from(depDir)]));
        },
      }),
    );
    expect(pulled).toEqual(["node_modules"]);
    expect(out[1]).toMatchObject({ depDir: "packages/app/node_modules", outcome: "error" });
    expect(pointerFor("packages/app/node_modules")).toBeNull();
  });
});

/**
 * docs/276 section 5 — the trigger for the verified pnpm base. The builder itself is faked here;
 * what these cells hold is WHEN it runs, WHAT it is asked to build from, and that no path through
 * it can touch the session's own install (req 9).
 */
describe("overlay-publish: the verified pnpm base trigger", () => {
  let tmpDir: string;
  let stateDir: string;
  let workspaceDir: string;
  let env: NodeJS.ProcessEnv;
  let runtimeKey: string;
  let built: PnpmBaseBuildRequest[];
  let pulled: string[];

  const oracle: AncestryOracle = {
    isAncestor: (a, b) => Promise.resolve(a !== b),
    resolveDefaultBranchCommit: () => Promise.resolve(HEAD),
  };

  const PUBLISHED: PnpmBaseBuildOutcome = { status: "published", outcome: "created", generation: 1 };

  function bareCacheDir(url: string): string {
    return path.join(tmpDir, "cache", encodeURIComponent(url));
  }

  function depsWith(over: Partial<OverlayPublishDeps> = {}): OverlayPublishDeps {
    return {
      stateDir,
      createRepoGit: () => oracle,
      getBareCacheDir: bareCacheDir,
      env,
      fetchHeadInfo: () => Promise.resolve({ commit: HEAD, runtimeKey: "img|x64" }),
      fetchSnapshot: (_url, depDir) => {
        pulled.push(depDir);
        return Promise.resolve(Readable.from([Buffer.from(depDir)]));
      },
      tmpRoot: tmpDir,
      buildPnpmBase: (req) => {
        built.push(req);
        return Promise.resolve(PUBLISHED);
      },
      ...over,
    };
  }

  function publish(over: Partial<OverlayPublishDeps> = {}, installOk = true) {
    return publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk },
      depsWith(over),
    );
  }

  function verifiedPointer() {
    return readBasePointer(stateDir, {
      repoUrl: REPO_URL,
      runtimeKey,
      depDir: "node_modules",
      namespace: PNPM_VERIFIED_NAMESPACE,
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovl-pub-pnpm-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    env = { OVERLAY_DEP_STORE: "1", SESSION_WORKER_IMAGE_ID: "img1" } as NodeJS.ProcessEnv;
    runtimeKey = overlayRuntimeKey(env);
    built = [];
    pulled = [];
    workspaceDir = makeWorkspace(["node_modules"]);
    fs.writeFileSync(path.join(workspaceDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("builds from the default-branch commit in the bare cache, never from the session's tree", async () => {
    const out = await publish();
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created", generation: 1 }]);
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({
      repoDir: bareCacheDir(REPO_URL),
      defaultBranchCommit: HEAD,
      scope: { repoUrl: REPO_URL, runtimeKey, depDir: "node_modules", namespace: PNPM_VERIFIED_NAMESPACE },
    });
    // The session-snapshot pull is off this path entirely: nothing reads the session's node_modules.
    expect(pulled).toEqual([]);
  });

  it("gives an ineligible repo no base, and the session keeps its own install", async () => {
    const buildPnpmBase = (): Promise<PnpmBaseBuildOutcome> =>
      Promise.resolve({
        status: "ineligible",
        detail: "local-specifier: the root manifest depends on ui as workspace:*",
        reason: { eligible: false, code: "local-specifier", detail: "workspace:*" },
      });
    const out = await publish({ buildPnpmBase });
    expect(out).toEqual([
      {
        depDir: "node_modules",
        outcome: "skipped-ineligible",
        detail: "local-specifier: the root manifest depends on ui as workspace:*",
      },
    ]);
    expect(verifiedPointer()).toBeNull();
  });

  it("skips the publish naming the first failing package when verification fails", async () => {
    const buildPnpmBase = (): Promise<PnpmBaseBuildOutcome> =>
      Promise.resolve({
        status: "verification-failed",
        failedPackage: "left-pad@1.3.0",
        detail: "the downloaded bytes do not hash to the lockfile digest",
      });
    const out = await publish({ buildPnpmBase });
    expect(out).toEqual([
      {
        depDir: "node_modules",
        outcome: "skipped-unverified",
        failedPackage: "left-pad@1.3.0",
        detail: "the downloaded bytes do not hash to the lockfile digest",
      },
    ]);
    expect(verifiedPointer()).toBeNull();
  });

  it("reports a build that did not finish, without failing the session", async () => {
    const buildPnpmBase = (): Promise<PnpmBaseBuildOutcome> =>
      Promise.resolve({ status: "build-failed", detail: "the build exited 1" });
    const out = await publish({ buildPnpmBase });
    expect(out).toEqual([
      { depDir: "node_modules", outcome: "build-failed", detail: "the build exited 1" },
    ]);
    expect(verifiedPointer()).toBeNull();
  });

  // Docker, the filesystem and the publish can all throw out of the builder. Losing the throw to
  // the caller's catch would lose the measurement line with it.
  it("reports a builder that threw as an error outcome rather than propagating it", async () => {
    const out = await publish({
      buildPnpmBase: () => Promise.reject(new Error("no such image: shipit-session-worker")),
    });
    expect(out).toEqual([
      {
        depDir: "node_modules",
        outcome: "error",
        error: "no such image: shipit-session-worker",
      },
    ]);
  });

  it("rebuilds when the pointer names a generation the sweep already reclaimed", async () => {
    const snapshotDir = path.join(tmpDir, "swept");
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, "content"), "prebuilt");
    const first = await publishBase({
      stateDir,
      scope: { repoUrl: REPO_URL, runtimeKey, depDir: "node_modules", namespace: PNPM_VERIFIED_NAMESPACE },
      candidate: { commit: HEAD, exitCode: 0, preUserInstall: true, sourceIsDefaultBranch: true, snapshotDir },
      isAncestor: () => Promise.resolve(false),
    });
    fs.rmSync(first.pointer!.baseDir, { recursive: true, force: true });

    const out = await publish();
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created", generation: 1 }]);
    expect(built).toHaveLength(1);
  });

  it("reports a trigger the per-scope guard turned away, and builds nothing", async () => {
    const buildPnpmBase = (): Promise<PnpmBaseBuildOutcome> =>
      Promise.resolve({ status: "skipped-building", detail: "a build of this base is already running" });
    const out = await publish({ buildPnpmBase });
    expect(out).toEqual([
      {
        depDir: "node_modules",
        outcome: "skipped-building",
        detail: "a build of this base is already running",
      },
    ]);
  });

  it("does not build when the session is not on the remote default branch", async () => {
    const other: AncestryOracle = {
      isAncestor: () => Promise.resolve(false),
      resolveDefaultBranchCommit: () => Promise.resolve("deadbeef".padEnd(40, "0")),
    };
    const out = await publish({ createRepoGit: () => other });
    expect(out).toEqual([{ depDir: "node_modules", outcome: "skipped-ineligible" }]);
    expect(built).toEqual([]);
  });

  it("does not build when the declared install failed", async () => {
    const out = await publish({}, false);
    expect(out).toEqual([{ depDir: "node_modules", outcome: "skipped-ineligible" }]);
    expect(built).toEqual([]);
  });

  it("does not spend a builder on a commit whose base is already published", async () => {
    const snapshotDir = path.join(tmpDir, "already");
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, "content"), "prebuilt");
    await publishBase({
      stateDir,
      scope: { repoUrl: REPO_URL, runtimeKey, depDir: "node_modules", namespace: PNPM_VERIFIED_NAMESPACE },
      candidate: {
        commit: HEAD,
        exitCode: 0,
        preUserInstall: true,
        sourceIsDefaultBranch: true,
        snapshotDir,
      },
      isAncestor: () => Promise.resolve(false),
    });

    const out = await publish();
    expect(out).toEqual([{ depDir: "node_modules", outcome: "skipped-equal", generation: 1 }]);
    expect(built).toEqual([]);
  });

  // No runner-bound cancellation (plan.md section 5): the inputs are staged out of the bare cache
  // and the registry is the orchestrator's, so a build outliving its triggering session finishes
  // and publishes. Both directions of that, because the npm/yarn loop in the same function turns an
  // aborted signal into an "error" outcome and an abort check copied onto this branch would take
  // either one: a session disposed BEFORE the build is admitted, and one disposed MID-build.
  it.each([["before", false], ["during", true]] as const)(
    "publishes when the triggering session is disposed %s the build",
    async (_when, duringBuild) => {
      const controller = new AbortController();
      const abort = (): void => controller.abort(new Error("session runner disposed"));
      if (!duringBuild) abort();
      const out = await publishDepDirOverlayBases(
        {
          session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir },
          workerUrl: "http://w",
          installOk: true,
          signal: controller.signal,
        },
        depsWith({
          buildPnpmBase: async (req) => {
            built.push(req);
            if (duringBuild) abort();
            // A real build spans many awaits after disposal; one is enough to show none of them
            // observes the signal.
            await Promise.resolve();
            return PUBLISHED;
          },
        }),
      );
      expect(out).toEqual([{ depDir: "node_modules", outcome: "created", generation: 1 }]);
      expect(built).toHaveLength(1);
    },
  );

  it("builds nothing for a pnpm repo that declares a dep dir the builder cannot produce", async () => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    workspaceDir = makeWorkspace(["node_modules", "vendor"], {
      shipitDepDirs: ["node_modules", "vendor"],
    });
    fs.writeFileSync(path.join(workspaceDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const out = await publish();
    expect(out).toEqual([
      { depDir: "node_modules", outcome: "skipped-ineligible", detail: expect.stringContaining("vendor") },
      { depDir: "vendor", outcome: "skipped-ineligible", detail: expect.stringContaining("vendor") },
    ]);
    expect(built).toEqual([]);
  });
});

describe("formatOverlayMeasurement", () => {
  it("renders a greppable single line with per-dir outcome + depth/generation", () => {
    const line = formatOverlayMeasurement({
      sessionId: "sess-1",
      repoUrl: "https://github.com/x/y.git",
      installOk: true,
      installDurationMs: 1843,
      outcomes: [
        { depDir: "node_modules", outcome: "advanced", depth: 3, generation: 4 },
        { depDir: "packages/api/node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 },
      ],
    });
    expect(line).toBe(
      "[overlay-measure] session=sess-1 repo=https://github.com/x/y.git install_ok=true install_ms=1843 " +
        "dirs=node_modules:advanced:d3g4,packages/api/node_modules:created:d1g1",
    );
  });

  it("omits the depth suffix for outcomes without a pointer (skips/errors)", () => {
    const line = formatOverlayMeasurement({
      sessionId: "s",
      repoUrl: "r",
      installOk: false,
      installDurationMs: 12,
      outcomes: [{ depDir: "node_modules", outcome: "skipped-ineligible" }],
    });
    expect(line).toBe(
      "[overlay-measure] session=s repo=r install_ok=false install_ms=12 dirs=node_modules:skipped-ineligible",
    );
  });

  it("renders the verified pnpm base's generation, which carries no lineage depth", () => {
    const line = formatOverlayMeasurement({
      sessionId: "s",
      repoUrl: "r",
      installOk: true,
      installDurationMs: 9,
      outcomes: [
        { depDir: "node_modules", outcome: "created", generation: 3 },
        { depDir: "node_modules", outcome: "skipped-unverified", failedPackage: "left-pad@1.3.0" },
      ],
    });
    expect(line).toContain("dirs=node_modules:created:g3,node_modules:skipped-unverified:left-pad@1.3.0");
  });

  it("adds `a<attempts>` ONLY when the retry fired, so an ordinary line is unchanged", () => {
    const line = formatOverlayMeasurement({
      sessionId: "s",
      repoUrl: "r",
      installOk: true,
      installDurationMs: 900,
      outcomes: [
        { depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 },
        { depDir: "game/node_modules", outcome: "advanced", depth: 2, generation: 5, attempts: 2 },
      ],
    });
    expect(line).toBe(
      "[overlay-measure] session=s repo=r install_ok=true install_ms=900 " +
        "dirs=node_modules:created:d1g1,game/node_modules:advanced:d2g5:a2",
    );
  });

  it("carries `a<attempts>` on an error, which has no depth segment before it", () => {
    const line = formatOverlayMeasurement({
      sessionId: "s",
      repoUrl: "r",
      installOk: true,
      installDurationMs: 900,
      outcomes: [{ depDir: "node_modules", outcome: "error", error: "tar exited with code 1", attempts: 2 }],
    });
    expect(line).toBe(
      "[overlay-measure] session=s repo=r install_ok=true install_ms=900 dirs=node_modules:error:a2",
    );
  });

  it("names the reason a declared dep dir was dropped, so a silent omission is visible", () => {
    const line = formatOverlayMeasurement({
      sessionId: "s",
      repoUrl: "r",
      installOk: true,
      installDurationMs: 900,
      outcomes: [
        { depDir: "node_modules", outcome: "created", depth: 1, generation: 1, attempts: 1 },
        { depDir: ".tools/blender", outcome: "dropped", dropReason: "missing-tracked-parent" },
      ],
    });
    expect(line).toBe(
      "[overlay-measure] session=s repo=r install_ok=true install_ms=900 " +
        "dirs=node_modules:created:d1g1,.tools/blender:dropped:missing-tracked-parent",
    );
  });
});
