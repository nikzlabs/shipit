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
import { readBasePointer, type OverlayScope } from "./overlay-base.js";
import { overlayRuntimeKey } from "./overlay-session.js";
import { overlayScopeHash } from "./overlay-volume.js";

/**
 * Phase 4b (docs/183) — publish-after-install orchestration. The worker pull and
 * tar extraction are injected (`fetchSnapshot`/`extract`) so the test drives real
 * publishes against a real `stateDir` without an HTTP worker; the git oracle is a
 * fake so eligibility/ordering are controlled directly.
 */

const REPO_URL = "https://github.com/acme/widgets.git";
const HEAD = "c0ffee".padEnd(40, "0");

/** A workspace git repo with the given dep dirs created on disk + git-ignored. */
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

  /** Oracle whose default branch is HEAD (→ sourceIsDefaultBranch true); forward-advances. */
  const oracle: AncestryOracle = {
    isAncestor: (a, b) => Promise.resolve(a !== b),
    resolveDefaultBranchCommit: () => Promise.resolve(HEAD),
  };

  /** `fetchSnapshot` carries the dep dir name; `extract` writes it as the base's sole file. */
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
    // Bases are generational — the pointer names the current generation's dir.
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
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1 }]);
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
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1 }]);
    expect(pointerFor("node_modules")?.marker).toEqual({
      runtimeKey: "img|x64|glibc|node24",
      installCommands: ["npm install"],
    });
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
      { depDir: "node_modules", outcome: "created", depth: 1, generation: 1 },
      { depDir: "packages/app/node_modules", outcome: "created", depth: 1, generation: 1 },
    ]);
    // Each base holds ONLY its own dep dir's snapshot — distinct scope hashes.
    expect(baseContentFor("node_modules")).toBe("node_modules");
    expect(baseContentFor("packages/app/node_modules")).toBe("packages/app/node_modules");
    expect(overlayScopeHash(REPO_URL, runtimeKey, "node_modules")).not.toBe(
      overlayScopeHash(REPO_URL, runtimeKey, "packages/app/node_modules"),
    );
  });

  it("propagates the climbing overlay depth on an advance (the depth-cap signal)", async () => {
    const c1 = "c1".padEnd(40, "0");
    const c2 = "c2".padEnd(40, "0");
    let head = c1; // the current default-branch tip; advances to c2 between publishes
    const oracle2: AncestryOracle = {
      isAncestor: (a, b) => Promise.resolve(a === c1 && b === c2),
      resolveDefaultBranchCommit: () => Promise.resolve(head),
    };
    const deps = depsWith({ createRepoGit: () => oracle2, fetchHeadInfo: () => Promise.resolve({ commit: head, runtimeKey: "img|x64|glibc|node24" }) });
    const session = { remoteUrl: REPO_URL, kind: undefined, workspaceDir };

    const first = await publishDepDirOverlayBases({ session, workerUrl: "http://w", installOk: true }, deps);
    expect(first).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1 }]);

    head = c2; // main advanced with a dep change
    const second = await publishDepDirOverlayBases({ session, workerUrl: "http://w", installOk: true }, deps);
    expect(second).toEqual([{ depDir: "node_modules", outcome: "advanced", depth: 2, generation: 2 }]);
  });

  it("no-ops when the feature flag is off", async () => {
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith({ env: {} as NodeJS.ProcessEnv }),
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

  // docs/198 — pnpm repos never overlay, so the publish hook must skip them at the
  // same `isPnpmRepo` decision point the mount side uses. Otherwise it exports +
  // publishes a never-mounted base generation (480 MB leak observed on the canary).
  it("no-ops for a pnpm repo (no base published), while an npm repo still publishes", async () => {
    // pnpm repo: a root pnpm-lock.yaml is the conventional signal.
    fs.writeFileSync(path.join(workspaceDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith(),
    );
    expect(out).toEqual([]);
    expect(pointerFor("node_modules")).toBeNull();
    expect(baseContentFor("node_modules")).toBeNull();

    // An otherwise-identical npm repo (no pnpm signal) still publishes its base.
    const npmWs = makeWorkspace(["node_modules"]);
    try {
      const npmOut = await publishDepDirOverlayBases(
        { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir: npmWs }, workerUrl: "http://w", installOk: true },
        depsWith(),
      );
      expect(npmOut).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1 }]);
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
    // publishBase classifies a non-default source as ineligible — no base written.
    expect(out).toEqual([{ depDir: "node_modules", outcome: "skipped-ineligible" }]);
    expect(pointerFor("node_modules")).toBeNull();
  });

  it("drops a dep dir that is tracked source (not git-ignored), keeping the ignored one", async () => {
    workspaceDir = makeWorkspace(["node_modules", "src/vendored"], {
      ignore: false,
      shipitDepDirs: ["node_modules", "src/vendored"],
    });
    // Only node_modules is ignored; src/vendored is tracked source.
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), "node_modules/\n");
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith(),
    );
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created", depth: 1, generation: 1 }]);
    expect(baseContentFor("node_modules")).toBe("node_modules");
    expect(baseContentFor("src/vendored")).toBeNull();
  });

  it("declines to publish an empty snapshot (no base, no pointer)", async () => {
    const out = await publishDepDirOverlayBases(
      { session: { remoteUrl: REPO_URL, kind: undefined, workspaceDir }, workerUrl: "http://w", installOk: true },
      depsWith({
        // The export yields a valid-but-empty archive — the signature of a
        // broken/empty merged view. Nothing may be published from it.
        extract: async (stream) => { for await (const _ of stream) { /* drain */ } },
      }),
    );
    expect(out).toEqual([{ depDir: "node_modules", outcome: "skipped-empty" }]);
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
    expect(out[1]).toEqual({ depDir: "packages/app/node_modules", outcome: "created", depth: 1, generation: 1 });
    // The failing dir wrote no base; the healthy dir did.
    expect(pointerFor("node_modules")).toBeNull();
    expect(baseContentFor("packages/app/node_modules")).toBe("packages/app/node_modules");
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
        { depDir: "packages/api/node_modules", outcome: "created", depth: 1, generation: 1 },
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
});
