import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  publishDepDirOverlayBases,
  type OverlayPublishDeps,
  type AncestryOracle,
} from "./overlay-publish.js";
import { readBasePointer, type OverlayScope } from "./overlay-base.js";
import { overlayRuntimeKey } from "./overlay-session.js";
import { overlayBaseDir, overlayScopeHash } from "./overlay-volume.js";

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
      fetchHeadCommit: () => Promise.resolve(HEAD),
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
    const scopeHash = overlayScopeHash(REPO_URL, runtimeKey, depDir);
    const f = path.join(overlayBaseDir(stateDir, scopeHash), "content");
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
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created" }]);
    expect(pointerFor("node_modules")).toMatchObject({ commit: HEAD, depth: 1 });
    expect(baseContentFor("node_modules")).toBe("node_modules");
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
      { depDir: "node_modules", outcome: "created" },
      { depDir: "packages/app/node_modules", outcome: "created" },
    ]);
    // Each base holds ONLY its own dep dir's snapshot — distinct scope hashes.
    expect(baseContentFor("node_modules")).toBe("node_modules");
    expect(baseContentFor("packages/app/node_modules")).toBe("packages/app/node_modules");
    expect(overlayScopeHash(REPO_URL, runtimeKey, "node_modules")).not.toBe(
      overlayScopeHash(REPO_URL, runtimeKey, "packages/app/node_modules"),
    );
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
      depsWith({ fetchHeadCommit: () => Promise.resolve(null) }),
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
    expect(out).toEqual([{ depDir: "node_modules", outcome: "created" }]);
    expect(baseContentFor("node_modules")).toBe("node_modules");
    expect(baseContentFor("src/vendored")).toBeNull();
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
    expect(out[1]).toEqual({ depDir: "packages/app/node_modules", outcome: "created" });
    // The failing dir wrote no base; the healthy dir did.
    expect(pointerFor("node_modules")).toBeNull();
    expect(baseContentFor("packages/app/node_modules")).toBe("packages/app/node_modules");
  });
});
