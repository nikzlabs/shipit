/**
 * Unit tests for the dependency content hash (docs/197 Part 1).
 *
 * Three concerns: (1) the command allowlist — which `agent.install` commands are
 * recognized pure dependency installs and which inputs they consume; (2) the
 * resolution rule — `install-inputs` override vs command-derived default vs
 * commit-only fallback; (3) the hash itself — deterministic, busts on a dep-file
 * edit, `null` when there's nothing to hash.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeDepsHash,
  computeInstallDepsHash,
  depInputsForCommand,
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

  it("rejects non-pure / unrecognized commands (→ null, commit-only)", () => {
    expect(depInputsForCommand("npm install lodash")).toBeNull(); // names a package
    expect(depInputsForCommand("npm run build")).toBeNull();
    expect(depInputsForCommand("yarn add react")).toBeNull();
    expect(depInputsForCommand("pip install flask")).toBeNull(); // no -r
    expect(depInputsForCommand("pip install")).toBeNull(); // no requirements file
    expect(depInputsForCommand("uv pip install foo")).toBeNull();
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

  it("returns null when the command list is empty", () => {
    expect(resolveDepsHashInputs([], null)).toBeNull();
  });

  it("an explicit install-inputs override replaces the default and opts back in", () => {
    // The command does codegen (would be null), but the override forces content-keying.
    expect(resolveDepsHashInputs(["npm run setup"], ["package.json", "prisma/schema.prisma"])).toEqual([
      "package.json",
      "prisma/schema.prisma",
    ]);
  });

  it("an explicit empty override yields [] (content-keying effectively off)", () => {
    expect(resolveDepsHashInputs(["npm ci"], [])).toEqual([]);
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
    // Recognized → hashes package.json.
    expect(computeInstallDepsHash(dir, ["npm install"], null)).not.toBeNull();
    // Codegen command, no override → null (commit-only).
    expect(computeInstallDepsHash(dir, ["npm run build"], null)).toBeNull();
    // Override opts back in even for the codegen command.
    expect(computeInstallDepsHash(dir, ["npm run build"], ["package.json"])).not.toBeNull();
  });
});
