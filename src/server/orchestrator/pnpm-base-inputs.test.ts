import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  decidePnpmBaseEligibility,
  stagePnpmInputs,
  PNPM_LOCKFILE,
  PNPM_WORKSPACE_YAML,
  type PnpmBaseEligibility,
  type StagedPnpmInputs,
} from "./pnpm-base-inputs.js";

const REGISTRY_URL = "https://registry.npmjs.org/";

const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      left-pad:
        specifier: 1.3.0
        version: 1.3.0

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-XI5MPzVNApjAyhQzphX8Bkm==}
`;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(files: Record<string, string>): { dir: string; commit: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-in-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@ship-it.ai");
  git(dir, "config", "user.name", "test");
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  git(dir, "add", "-A", "-f");
  git(dir, "commit", "-q", "-m", "seed");
  return { dir, commit: git(dir, "rev-parse", "HEAD") };
}

async function stage(files: Record<string, string>): Promise<StagedPnpmInputs> {
  const repo = makeRepo(files);
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-stage-"));
  const staged = await stagePnpmInputs({ repoDir: repo.dir, commit: repo.commit, destDir });
  if ("eligible" in staged) throw new Error(`staging refused: ${staged.code} ${staged.detail}`);
  return staged;
}

function decide(staged: StagedPnpmInputs): PnpmBaseEligibility {
  return decidePnpmBaseEligibility(staged, { registryUrl: REGISTRY_URL });
}

const BASE_FILES = {
  "package.json": JSON.stringify({ name: "app", dependencies: { "left-pad": "1.3.0" } }),
  [PNPM_LOCKFILE]: LOCK,
};

describe("stagePnpmInputs", () => {
  const dirs: string[] = [];
  beforeEach(() => dirs.splice(0));
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it("stages every input out of the commit, not out of the working tree", async () => {
    const repo = makeRepo({
      ...BASE_FILES,
      [PNPM_WORKSPACE_YAML]: "packages:\n  - packages/*\n",
      ".npmrc": "shamefully-hoist=false\n",
      "packages/api/package.json": JSON.stringify({ name: "api" }),
    });
    dirs.push(repo.dir);
    // A later working-tree edit must not reach the snapshot: this is the immutability the
    // eligibility decision rests on (plan.md section 5, "Inputs and verification").
    fs.writeFileSync(path.join(repo.dir, PNPM_LOCKFILE), "lockfileVersion: 'evil'\n");

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-stage-"));
    dirs.push(destDir);
    const staged = await stagePnpmInputs({ repoDir: repo.dir, commit: repo.commit, destDir });
    if ("eligible" in staged) throw new Error("expected staging to succeed");

    expect(staged.lock.lockfileVersion).toBe("9.0");
    expect(fs.readFileSync(path.join(destDir, PNPM_LOCKFILE), "utf8")).toBe(LOCK);
    expect(staged.manifests).toEqual(["package.json", "packages/api/package.json"]);
    expect(fs.existsSync(path.join(destDir, "packages/api/package.json"))).toBe(true);
    expect(staged.npmrc.map((n) => n.relPath)).toEqual([".npmrc"]);
    expect(staged.workspaceYaml).toEqual({ packages: ["packages/*"] });
  });

  it("refuses a commit with no lockfile", async () => {
    const repo = makeRepo({ "package.json": "{}" });
    dirs.push(repo.dir);
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-stage-"));
    dirs.push(destDir);
    const staged = await stagePnpmInputs({ repoDir: repo.dir, commit: repo.commit, destDir });
    expect(staged).toMatchObject({ eligible: false, code: "no-lockfile" });
  });

  it("never stages a committed node_modules as a build input", async () => {
    const repo = makeRepo({
      ...BASE_FILES,
      "node_modules/evil/package.json": JSON.stringify({ name: "evil" }),
    });
    dirs.push(repo.dir);
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-stage-"));
    dirs.push(destDir);
    const staged = await stagePnpmInputs({ repoDir: repo.dir, commit: repo.commit, destDir });
    if ("eligible" in staged) throw new Error("expected staging to succeed");
    expect(staged.manifests).toEqual(["package.json"]);
    expect(fs.existsSync(path.join(destDir, "node_modules"))).toBe(false);
  });
});

describe("decidePnpmBaseEligibility", () => {
  it("admits a lockfile of plain registry packages", async () => {
    const decision = decide(await stage(BASE_FILES));
    expect(decision).toEqual({
      eligible: true,
      packages: [
        {
          key: "left-pad@1.3.0",
          name: "left-pad",
          version: "1.3.0",
          integrity: "sha512-XI5MPzVNApjAyhQzphX8Bkm==",
        },
      ],
    });
  });

  /**
   * Measured 2026-09-21 against the pinned builder (pnpm 12.4.1, store `v11`): a pnpm 10.28.2
   * consumer prints "Recreating node_modules" and re-downloads, where 11.22.0 and 12.5.1 read the
   * base with no recreate and no download. pnpm 12 accepts a pnpm-10 `lockfileVersion: '9.0'` under
   * `--frozen-lockfile`, so nothing else in this decision would have caught such a repo.
   */
  it("refuses a repo pinning a pnpm whose store version the base would not match", async () => {
    // `devEngines.packageManager` is the second route, and it is not optional: measured on corepack
    // 0.34.6 that it selects pnpm 10.28.2 on its own, with no top-level `packageManager` at all.
    const pins = [
      { packageManager: "pnpm@10.28.2" },
      { devEngines: { packageManager: { name: "pnpm", version: "10.28.2" } } },
    ];
    for (const pin of pins) {
      const decision = decide(
        await stage({
          ...BASE_FILES,
          "package.json": JSON.stringify({ name: "app", ...pin, dependencies: { "left-pad": "1.3.0" } }),
        }),
      );
      expect(decision, JSON.stringify(pin)).toMatchObject({
        eligible: false,
        code: "incompatible-package-manager",
      });
    }
  });

  it("admits a repo pinning the builder's own major, and one pinning nothing", async () => {
    for (const packageManager of ["pnpm@11.22.0", "pnpm@12.5.1", undefined]) {
      const decision = decide(
        await stage({
          ...BASE_FILES,
          "package.json": JSON.stringify({
            name: "app",
            ...(packageManager ? { packageManager } : {}),
            dependencies: { "left-pad": "1.3.0" },
          }),
        }),
      );
      expect(decision.eligible, `packageManager=${packageManager ?? "(absent)"}`).toBe(true);
    }
  });

  it("refuses an entry with no registry digest to verify against", async () => {
    const decision = decide(
      await stage({
        ...BASE_FILES,
        [PNPM_LOCKFILE]: `${LOCK}
  gitdep@1.0.0:
    resolution: {type: git, repo: git@github.com:acme/x.git, commit: abc}
`,
      }),
    );
    expect(decision).toMatchObject({ eligible: false, code: "unverifiable-entry" });
  });

  it.each([
    ["link:", "link:../local"],
    ["file:", "file:../local"],
    ["workspace:", "workspace:*"],
  ])("refuses a %s specifier, whose content is not a published tarball", async (_label, spec) => {
    const decision = decide(
      await stage({
        ...BASE_FILES,
        [PNPM_LOCKFILE]: LOCK.replace("specifier: 1.3.0", `specifier: ${spec}`),
      }),
    );
    expect(decision).toMatchObject({ eligible: false, code: "local-specifier" });
  });

  it("refuses a local edge an ordinary specifier RESOLVED to", async () => {
    // The shape a specifier-only check misses, and the one that arises naturally whenever a
    // workspace package satisfies a plain semver range.
    const decision = decide(
      await stage({
        ...BASE_FILES,
        [PNPM_LOCKFILE]: LOCK.replace("version: 1.3.0", "version: link:packages/local"),
      }),
    );
    expect(decision).toMatchObject({ eligible: false, code: "local-specifier" });
  });

  it("refuses a local edge a transitive resolved to", async () => {
    const decision = decide(
      await stage({
        ...BASE_FILES,
        [PNPM_LOCKFILE]: `${LOCK}
snapshots:

  left-pad@1.3.0:
    dependencies:
      helper: link:packages/helper
`,
      }),
    );
    expect(decision).toMatchObject({ eligible: false, code: "local-specifier" });
  });

  it("admits an npm: alias, whose resolved target is what gets verified", async () => {
    const decision = decide(
      await stage({
        ...BASE_FILES,
        [PNPM_LOCKFILE]: LOCK.replace("specifier: 1.3.0", "specifier: npm:left-pad@1.3.0"),
      }),
    );
    expect(decision.eligible).toBe(true);
  });

  it("refuses a patched dependency declared in the lockfile or the manifest", async () => {
    const fromLock = decide(
      await stage({
        ...BASE_FILES,
        [PNPM_LOCKFILE]: `${LOCK}
patchedDependencies:
  left-pad@1.3.0:
    path: patches/left-pad.patch
`,
      }),
    );
    expect(fromLock).toMatchObject({ eligible: false, code: "patched-dependency" });

    const fromManifest = decide(
      await stage({
        ...BASE_FILES,
        "package.json": JSON.stringify({
          name: "app",
          dependencies: { "left-pad": "1.3.0" },
          pnpm: { patchedDependencies: { "left-pad@1.3.0": "patches/left-pad.patch" } },
        }),
      }),
    );
    expect(fromManifest).toMatchObject({ eligible: false, code: "patched-dependency" });
  });

  it.each([
    [".pnpmfile.cjs", "module.exports = {};"],
    [".pnpmfile.mjs", "export default {};"],
  ])("admits a committed %s, and does not stage it", async (file, text) => {
    // Both halves, because admitting on eligibility alone would stay green if staging ever began
    // copying hook sources — and "it never reaches the builder" is what makes the admission safe.
    // `--ignore-pnpmfile` on both builder phases is the layer behind that, guarded separately in
    // `pnpm-base-builder.test.ts`.
    const staged = await stage({ ...BASE_FILES, [file]: text });
    expect(decide(staged).eligible).toBe(true);
    // The lockfile is the positive control: without it, "the hook is absent" would also hold
    // for a `staged.dir` that was empty or misread.
    expect(fs.existsSync(path.join(staged.dir, PNPM_LOCKFILE))).toBe(true);
    expect(fs.existsSync(path.join(staged.dir, file))).toBe(false);
  });

  it("refuses configDependencies, whose plugin packages no lockfile digest covers", async () => {
    const decision = decide(
      await stage({
        ...BASE_FILES,
        [PNPM_WORKSPACE_YAML]: "configDependencies:\n  my-plugin: 1.0.0\n",
      }),
    );
    expect(decision).toMatchObject({ eligible: false, code: "config-dependencies" });
  });

  it.each([
    [PNPM_WORKSPACE_YAML, "nodeLinker: hoisted\n"],
    [PNPM_WORKSPACE_YAML, "modulesDir: ../shared-modules\n"],
    [PNPM_WORKSPACE_YAML, "virtualStoreDir: ../.pnpm\n"],
  ])("refuses %s setting a layout that escapes one node_modules", async (file, text) => {
    const decision = decide(await stage({ ...BASE_FILES, [file]: text }));
    expect(decision).toMatchObject({ eligible: false, code: "escaping-layout" });
  });

  it.each([
    [PNPM_WORKSPACE_YAML, "nodeLinker: isolated\n"],
    [PNPM_WORKSPACE_YAML, "modulesDir: node_modules\n"],
    [PNPM_WORKSPACE_YAML, "virtualStoreDir: node_modules/.pnpm\n"],
  ])("admits %s declaring the supported layout explicitly", async (file, text) => {
    // Rejecting on the key's presence would cost a base to every repo that spells out the
    // layout the base already has — reqs 2, 10 and 13 for no gain.
    const decision = decide(await stage({ ...BASE_FILES, [file]: text }));
    expect(decision.eligible).toBe(true);
  });

  it("refuses an .npmrc that moves the layout", async () => {
    const decision = decide(await stage({ ...BASE_FILES, ".npmrc": "node-linker=hoisted\n" }));
    expect(decision).toMatchObject({ eligible: false, code: "escaping-layout" });
  });

  it.each([
    [PNPM_WORKSPACE_YAML, "globalPnpmfile: ./hooks.cjs\n"],
    [PNPM_WORKSPACE_YAML, "pnpmfile: ./hooks.cjs\n"],
    [".npmrc", "global-pnpmfile=./hooks.cjs\n"],
  ])("refuses %s pointing pnpm at a hook to execute", async (file, text) => {
    // The attack this closes: the named path need not itself be a hook source. Every
    // package.json in the tree is staged, so `hooks.cjs/package.json` with `main: "../.npmrc"`
    // has Node resolve the hook to the staged `.npmrc` and execute it inside the builder.
    const decision = decide(
      await stage({
        ...BASE_FILES,
        [file]: text,
        "hooks.cjs/package.json": JSON.stringify({ main: "../.npmrc" }),
      }),
    );
    expect(decision).toMatchObject({ eligible: false, code: "hook-source" });
  });

  it("refuses an .npmrc that repoints the registry the orchestrator chose", async () => {
    const decision = decide(
      await stage({ ...BASE_FILES, ".npmrc": "registry=https://evil.test/\n" }),
    );
    expect(decision).toMatchObject({ eligible: false, code: "unauthorized-registry" });
  });

  it("accepts an .npmrc that merely restates the orchestrator's own registry", async () => {
    const decision = decide(
      await stage({ ...BASE_FILES, ".npmrc": "registry=https://registry.npmjs.org\n" }),
    );
    expect(decision.eligible).toBe(true);
  });

  it("refuses a scoped registry the orchestrator did not authorize, and admits one it did", async () => {
    const staged = await stage({
      ...BASE_FILES,
      ".npmrc": "@acme:registry=https://npm.acme.test/\n",
    });
    expect(decidePnpmBaseEligibility(staged, { registryUrl: REGISTRY_URL })).toMatchObject({
      eligible: false,
      code: "unauthorized-registry",
    });
    expect(
      decidePnpmBaseEligibility(staged, {
        registryUrl: REGISTRY_URL,
        authorizedScopeRegistries: { "@acme": "https://npm.acme.test/" },
      }).eligible,
    ).toBe(true);
  });

  it("admits a relocated store, which the builder overrides on the command line", async () => {
    const decision = decide(await stage({ ...BASE_FILES, ".npmrc": "store-dir=/tmp/mystore\n" }));
    expect(decision.eligible).toBe(true);
  });

  it("admits a repo whose OWN manifest runs install scripts", async () => {
    // Only a dependency's install-time build makes a candidate ineligible (planning#604). The
    // builder never runs the root project's scripts, and the session runs them itself over
    // whatever tree it ends up with, built or not.
    const decision = decide(
      await stage({
        ...BASE_FILES,
        "package.json": JSON.stringify({
          name: "app",
          dependencies: { "left-pad": "1.3.0" },
          scripts: { preinstall: "node tools/check.js", postinstall: "node tools/gen.js" },
        }),
      }),
    );
    expect(decision.eligible).toBe(true);
  });

  it("admits a deprecated-but-present version, which is still a published tarball", async () => {
    const decision = decide(
      await stage({
        ...BASE_FILES,
        [PNPM_LOCKFILE]: `${LOCK}    deprecated: use String.prototype.padStart()\n`,
      }),
    );
    expect(decision.eligible).toBe(true);
  });

  it("verifies an optional dependency like any other entry", async () => {
    const decision = decide(
      await stage({
        ...BASE_FILES,
        [PNPM_LOCKFILE]: LOCK.replace("    dependencies:", "    optionalDependencies:"),
      }),
    );
    expect(decision).toEqual({
      eligible: true,
      packages: [
        {
          key: "left-pad@1.3.0",
          name: "left-pad",
          version: "1.3.0",
          integrity: "sha512-XI5MPzVNApjAyhQzphX8Bkm==",
        },
      ],
    });
  });

  it("refuses an unparseable pnpm-workspace.yaml rather than treating it as absent", async () => {
    const repo = makeRepo({ ...BASE_FILES, [PNPM_WORKSPACE_YAML]: "a: [\n" });
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-stage-"));
    const staged = await stagePnpmInputs({ repoDir: repo.dir, commit: repo.commit, destDir });
    expect(staged).toMatchObject({ eligible: false, code: "unreadable-input" });
  });

  it("gives a lockfile with no packages no base, rather than reporting a failed build", async () => {
    const decision = decide(
      await stage({
        "package.json": JSON.stringify({ name: "app" }),
        [PNPM_LOCKFILE]: "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n",
      }),
    );
    expect(decision).toMatchObject({ eligible: false, code: "no-dependencies" });
  });

  it("refuses a lockfile version this builder does not parse", async () => {
    const decision = decide(
      await stage({ ...BASE_FILES, [PNPM_LOCKFILE]: LOCK.replace("'9.0'", "'6.0'") }),
    );
    expect(decision).toMatchObject({ eligible: false, code: "unsupported-lockfile-version" });
  });
});
