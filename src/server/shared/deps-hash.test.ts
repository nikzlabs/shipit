import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeDepsHash,
  computeInstallDepsHash,
  depInputsForCommand,
  hasInstallLifecycleScript,
  resolveDepsHashInputs,
} from "./deps-hash.js";

describe("depInputsForCommand — allowlist", () => {
  it("recognizes bare npm install / ci / i", () => {
    expect(depInputsForCommand("npm install")).toEqual(["package.json", "package-lock.json"]);
    expect(depInputsForCommand("npm ci")).toEqual(["package.json", "package-lock.json"]);
    expect(depInputsForCommand("npm i")).toEqual(["package.json", "package-lock.json"]);
  });

  it("tolerates common npm flags", () => {
    expect(depInputsForCommand("npm ci --no-audit --no-fund --prefer-offline")).toEqual([
      "package.json",
      "package-lock.json",
    ]);
  });

  it("recognizes pnpm / yarn / uv pure installs", () => {
    expect(depInputsForCommand("pnpm install --frozen-lockfile")).toEqual([
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ]);
    expect(depInputsForCommand("yarn install --immutable")).toEqual(["package.json", "yarn.lock"]);
    expect(depInputsForCommand("yarn")).toEqual(["package.json", "yarn.lock"]);
    expect(depInputsForCommand("uv sync --frozen")).toEqual(["pyproject.toml", "uv.lock"]);
  });

  it("recognizes pip install -r in its several spellings", () => {
    expect(depInputsForCommand("pip install -r requirements.txt")).toEqual(["requirements.txt"]);
    expect(depInputsForCommand("pip3 install --requirement reqs/base.txt --no-cache-dir")).toEqual([
      "reqs/base.txt",
    ]);
    expect(depInputsForCommand("pip install -rrequirements.txt")).toEqual(["requirements.txt"]);
    expect(depInputsForCommand("pip install -r a.txt -r b.txt")).toEqual(["a.txt", "b.txt"]);
  });

  it("recognizes uv venv / python3 -m venv as input-free (→ [], does not disable content path)", () => {
    expect(depInputsForCommand("uv venv")).toEqual([]);
    expect(depInputsForCommand("uv venv .venv")).toEqual([]);
    expect(depInputsForCommand("python3 -m venv .venv")).toEqual([]);
    expect(depInputsForCommand("python -m venv")).toEqual([]);
  });

  it("recognizes uv pip install -r and uv pip sync <file>", () => {
    expect(depInputsForCommand("uv pip install -r requirements.txt")).toEqual(["requirements.txt"]);
    expect(depInputsForCommand("uv pip install -r requirements.txt --no-cache-dir")).toEqual([
      "requirements.txt",
    ]);
    expect(depInputsForCommand("uv pip sync requirements.txt")).toEqual(["requirements.txt"]);
  });

  it("rejects non-pure / unrecognized commands (→ null, commit-only)", () => {
    expect(depInputsForCommand("npm install lodash")).toBeNull();
    expect(depInputsForCommand("npm run build")).toBeNull();
    expect(depInputsForCommand("yarn add react")).toBeNull();
    expect(depInputsForCommand("pip install flask")).toBeNull();
    expect(depInputsForCommand("pip install")).toBeNull();
    expect(depInputsForCommand("uv pip install foo")).toBeNull();
    expect(depInputsForCommand("uv pip install")).toBeNull();
    expect(depInputsForCommand("python3 app.py")).toBeNull();
    expect(depInputsForCommand("npx prisma generate")).toBeNull();
    expect(depInputsForCommand("./build.sh")).toBeNull();
    expect(depInputsForCommand("")).toBeNull();
  });
});

describe("resolveDepsHashInputs — override vs default vs fallback", () => {
  it("uses the command-derived union when no override is set", () => {
    expect(resolveDepsHashInputs(["npm ci"], null)).toEqual(["package.json", "package-lock.json"]);
  });

  it("returns null when ANY command is not a recognized pure install", () => {
    expect(resolveDepsHashInputs(["npm ci", "npx prisma generate"], null)).toBeNull();
  });

  it("keeps content-keying when a venv-creation step precedes a recognized install (live canary)", () => {
    expect(
      resolveDepsHashInputs(["uv venv .venv", "uv pip install -r requirements.txt"], null),
    ).toEqual(["requirements.txt"]);
  });

  it("returns null when the command list is empty", () => {
    expect(resolveDepsHashInputs([], null)).toBeNull();
  });

  it("an explicit install-inputs override replaces the default and opts back in", () => {
    expect(resolveDepsHashInputs(["npm run setup"], ["package.json", "prisma/schema.prisma"])).toEqual([
      "package.json",
      "prisma/schema.prisma",
    ]);
  });

  it("an explicit empty override yields [] (content-keying effectively off)", () => {
    expect(resolveDepsHashInputs(["npm ci"], [])).toEqual([]);
  });
});

/**
 * docs/276-shared-package-cache-integrity section 5: the pnpm install marker now requires the
 * content hash, and `pnpm-workspace.yaml` is where the build approvals live — so it has to be IN
 * that hash. The default list already carries it; a custom `installInputs` replaces the list
 * wholesale, which is how the approval file could be absent from the hash entirely.
 */
describe("resolveDepsHashInputs — pnpm-workspace.yaml is never droppable (docs/276 section 5)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "depshash-pnpm-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function pnpmRepo(): void {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@12.4.1" }));
  }

  it("adds it to a custom install-inputs list that omitted it", () => {
    pnpmRepo();
    expect(resolveDepsHashInputs(["pnpm run setup"], ["package.json"], dir)).toEqual([
      "package.json",
      "pnpm-workspace.yaml",
    ]);
  });

  it("does not duplicate it when the list already names it", () => {
    pnpmRepo();
    const inputs = ["package.json", "pnpm-workspace.yaml"];
    expect(resolveDepsHashInputs(["pnpm run setup"], inputs, dir)).toEqual(inputs);
  });

  /**
   * `install-inputs: []` is the explicit opt-out from content-keying. Adding the approval file to
   * it would turn keying back ON with that file as the only input — and with the pnpm marker
   * requiring the content hash, an unchanged approval file would then skip an install that a
   * lockfile change under a different commit genuinely needed (review, 2026-09-21).
   */
  it("respects an explicit empty install-inputs, rather than making it approvals-only", () => {
    pnpmRepo();
    fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "onlyBuiltDependencies: []\n");
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    expect(resolveDepsHashInputs(["pnpm run setup"], [], dir)).toEqual([]);
    // Content-keying stays off, so the marker cannot skip on a hash at all.
    expect(computeInstallDepsHash(dir, ["pnpm run setup"], [])).toBeNull();
  });

  it("leaves a non-pnpm repo's custom list untouched", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ packageManager: "npm@11.0.0" }));
    expect(resolveDepsHashInputs(["npm run setup"], ["package.json"], dir)).toEqual(["package.json"]);
  });

  it("changes the install hash when a custom-input pnpm repo edits its build approvals", () => {
    pnpmRepo();
    const custom = ["package.json"];
    fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "onlyBuiltDependencies: []\n");
    const before = computeInstallDepsHash(dir, ["pnpm run setup"], custom);
    fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "onlyBuiltDependencies:\n  - esbuild\n");
    const after = computeInstallDepsHash(dir, ["pnpm run setup"], custom);
    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
  });
});

describe("computeDepsHash + computeInstallDepsHash", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "depshash-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is deterministic and order-independent across input ordering", () => {
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
    fs.writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    const a = computeDepsHash(dir, ["package.json", "package-lock.json"]);
    const b = computeDepsHash(dir, ["package-lock.json", "package.json"]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("changes when a dep file's content changes (busts the skip)", () => {
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
    const before = computeDepsHash(dir, ["package.json"]);
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x","dependencies":{"left-pad":"1"}}');
    const after = computeDepsHash(dir, ["package.json"]);
    expect(after).not.toBe(before);
  });

  it("changes when a previously-absent lockfile appears", () => {
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
    const before = computeDepsHash(dir, ["package.json", "package-lock.json"]);
    fs.writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    const after = computeDepsHash(dir, ["package.json", "package-lock.json"]);
    expect(after).not.toBe(before);
  });

  it("returns null when NONE of the input files exist", () => {
    expect(computeDepsHash(dir, ["package.json", "package-lock.json"])).toBeNull();
  });

  it("computeInstallDepsHash gates on the command allowlist", () => {
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
    expect(computeInstallDepsHash(dir, ["npm install"], null)).not.toBeNull();
    expect(computeInstallDepsHash(dir, ["npm run build"], null)).toBeNull();
    expect(computeInstallDepsHash(dir, ["npm run build"], ["package.json"])).not.toBeNull();
  });
});

describe("hasInstallLifecycleScript", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (pkg: unknown): void =>
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));

  it.each(["preinstall", "install", "postinstall", "prepare", "prepublish"])(
    "detects %s — an install RUNS it, so its output is not a function of the hashed inputs",
    (script) => {
      write({ name: "x", scripts: { [script]: "node scripts/build.js" } });
      expect(hasInstallLifecycleScript(dir)).toBe(true);
    },
  );

  it("ignores scripts an install does NOT run", () => {
    write({ name: "x", scripts: { build: "tsc", test: "vitest", start: "node ." } });
    expect(hasInstallLifecycleScript(dir)).toBe(false);
  });

  it("an empty script value is not a lifecycle script", () => {
    write({ name: "x", scripts: { postinstall: "" } });
    expect(hasInstallLifecycleScript(dir)).toBe(false);
  });

  it.each([
    ["no package.json at all", null],
    ["no scripts block", { name: "x" } as unknown],
    ["a non-object scripts value", { name: "x", scripts: "nope" } as unknown],
  ])("reads %s as no — there is then no npm install to have a lifecycle", (_label, pkg) => {
    if (pkg !== null) write(pkg);
    expect(hasInstallLifecycleScript(dir)).toBe(false);
  });

  it("unparseable JSON reads as no rather than throwing", () => {
    fs.writeFileSync(path.join(dir, "package.json"), "{not json");
    expect(hasInstallLifecycleScript(dir)).toBe(false);
  });
});
