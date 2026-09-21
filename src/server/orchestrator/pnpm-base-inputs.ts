import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { safeSimpleGit } from "../shared/git-hooks-guard.js";
import {
  declaredPnpmFromManifest,
  MIN_VERIFIED_BASE_PNPM_MAJOR,
  type DeclaredPnpm,
} from "../shared/pnpm-repo.js";
import { parsePnpmLock, PnpmLockParseError, type ParsedPnpmLock } from "./pnpm-lockfile.js";

/**
 * The immutable input snapshot the verified pnpm base is built from, and the single
 * eligibility decision over it (docs/276-shared-package-cache-integrity plan.md section 5,
 * "Inputs and verification"; reqs 1, 3, 6).
 *
 * Everything is read from ONE default-branch commit through git, never from the session's
 * mutable checkout: an input the session can still change between the decision and the build
 * is an input the decision does not cover.
 */

export const PNPM_LOCKFILE = "pnpm-lock.yaml";
export const PNPM_WORKSPACE_YAML = "pnpm-workspace.yaml";

/** A repo with more manifests than this is refused rather than staged; see `stagePnpmInputs`. */
export const MAX_STAGED_MANIFESTS = 2000;

/** Every input here is repo-authored, so parsing one is work a repo can ask the orchestrator for. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/**
 * Total across every `patchedDependencies` file. A patch is a diff against one package, so this
 * is generous; the bound exists because the patch paths are repo-chosen, and it is checked
 * against each object's size BEFORE the object is read.
 */
export const MAX_PATCH_BYTES = 4 * 1024 * 1024;

/**
 * One `patchedDependencies` entry, resolved against the commit.
 *
 * `relPath` comes from `pnpm-workspace.yaml`, which is where pnpm 12 reads patch paths — the
 * `pnpm` field in `package.json` is no longer read at all (measured 2026-09-21 on 12.5.1:
 * "The \"pnpm\" field in package.json is no longer read by pnpm", and the patch is not applied).
 */
export interface StagedPatch {
  key: string;
  relPath: string | null;
  /** The hash pnpm derives from the staged patch, or null when the commit carries no such file. */
  sha256: string | null;
  /** What `pnpm-lock.yaml` pins this patch to, or null when the lockfile pins nothing for it. */
  lockHash: string | null;
}

export interface StagedPnpmInputs {
  /** Directory holding the staged copy of every build input. */
  dir: string;
  commit: string;
  lockText: string;
  lock: ParsedPnpmLock;
  workspaceYaml: Record<string, unknown> | null;
  /** `.npmrc` files that apply to the build, root first. */
  npmrc: { relPath: string; text: string }[];
  /** The pnpm the root manifest declares, which is what corepack selects in a consuming session. */
  declaredPnpm: DeclaredPnpm | null;
  /** Repo-relative paths of staged manifests, root first. */
  manifests: string[];
  /** Every `patchedDependencies` entry the lockfile or `pnpm-workspace.yaml` names. */
  patches: StagedPatch[];
}

export type PnpmIneligibleCode =
  | "no-lockfile"
  | "unreadable-lockfile"
  | "unreadable-input"
  | "unsafe-input-path"
  | "unsupported-lockfile-version"
  | "no-manifest"
  | "too-many-manifests"
  | "unverifiable-entry"
  | "no-dependencies"
  | "patched-dependency"
  | "local-specifier"
  | "hook-source"
  | "config-dependencies"
  | "unauthorized-registry"
  | "escaping-layout"
  | "incompatible-package-manager"
  | "install-script";

export interface PnpmIneligible {
  eligible: false;
  code: PnpmIneligibleCode;
  detail: string;
}

export interface PnpmEligible {
  eligible: true;
  /** Registry packages to resolve, verify and stage, in lockfile order. */
  packages: { key: string; name: string; version: string; integrity: string }[];
}

export type PnpmBaseEligibility = PnpmEligible | PnpmIneligible;

/** Lockfile major versions whose `packages`/`importers` shape this parser was written against. */
const SUPPORTED_LOCKFILE_MAJORS = new Set(["9", "10"]);

/** Specifier prefixes that resolve outside the staged snapshot. `npm:` aliases are admitted. */
const LOCAL_SPECIFIER = /^(?:file:|link:|workspace:|git\+|git:|github:|https?:)/;

/**
 * Layout settings, each with the one value that describes the layout the base IS. Declaring
 * the default explicitly is common and must not cost a repo its base; any other value moves
 * output out of one self-contained `node_modules`.
 */
const LAYOUT_DEFAULTS: Record<string, string> = {
  modulesDir: "node_modules",
  "modules-dir": "node_modules",
  virtualStoreDir: "node_modules/.pnpm",
  "virtual-store-dir": "node_modules/.pnpm",
  nodeLinker: "isolated",
  "node-linker": "isolated",
};

/**
 * Settings that point pnpm at a hook source. A hook is not a script, and one that runs in the
 * builder can rewrite the output the orchestrator then publishes — including by naming a file
 * the snapshot stages for another reason. `--ignore-pnpmfile` suppresses them; this refuses
 * them as well, because the two together are what make "no repo code runs" a fact rather than
 * a flag that has to stay on every invocation for ever.
 */
const HOOK_CONFIG_KEYS = ["pnpmfile", "globalPnpmfile", "global-pnpmfile"];

function layoutViolation(key: string, value: unknown): boolean {
  const expected = LAYOUT_DEFAULTS[key];
  if (expected === undefined) return false;
  return typeof value !== "string" || value.replace(/^\.\//, "").replace(/\/+$/, "") !== expected;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type GitShow = (commit: string, relPath: string) => Promise<string | null>;
export type GitListTree = (commit: string) => Promise<string[]>;
export type GitSizeOf = (commit: string, relPath: string) => Promise<number | null>;

export interface StagePnpmInputsDeps {
  show?: GitShow;
  listTree?: GitListTree;
  sizeOf?: GitSizeOf;
}

/**
 * pnpm hashes a patch as its UTF-8 text with CRLF normalized to LF, not as its raw bytes —
 * measured 2026-09-21: a CRLF copy of a patch satisfies the LF hash its lockfile pins. Hashing
 * the bytes would take a base off every repo with a CRLF-committed patch. The file is still
 * staged verbatim, so the builder's own applier sees the committed bytes.
 */
function patchHash(text: string): string {
  return crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

function defaultGit(repoDir: string): Required<StagePnpmInputsDeps> {
  const git = safeSimpleGit(repoDir);
  return {
    listTree: async (commit) =>
      (await git.raw(["ls-tree", "-r", "--name-only", "-z", commit]))
        .split("\0")
        .filter((p) => p.length > 0),
    show: async (commit, relPath) => {
      try {
        return await git.raw(["show", `${commit}:${relPath}`]);
      } catch {
        return null;
      }
    },
    sizeOf: async (commit, relPath) => {
      try {
        const size = Number((await git.raw(["cat-file", "-s", `${commit}:${relPath}`])).trim());
        return Number.isFinite(size) ? size : null;
      } catch {
        return null;
      }
    },
  };
}

/** `node_modules` content committed to the repo is never a build input. */
function isBuildInputPath(p: string): boolean {
  return !p.split("/").includes("node_modules");
}

/**
 * Copy every build input out of one commit into `destDir`, preserving repo-relative paths.
 *
 * Reports ineligible rather than throwing when the commit cannot be a build: no
 * `pnpm-lock.yaml`, no root manifest, or an input the decision below could not read — an
 * unreadable input must not become an unchecked one.
 */
export async function stagePnpmInputs(args: {
  repoDir: string;
  commit: string;
  destDir: string;
  deps?: StagePnpmInputsDeps;
}): Promise<StagedPnpmInputs | PnpmIneligible> {
  const git = { ...defaultGit(args.repoDir), ...args.deps };
  const tree = (await git.listTree(args.commit)).filter(isBuildInputPath);

  const lockText = tree.includes(PNPM_LOCKFILE) ? await git.show(args.commit, PNPM_LOCKFILE) : null;
  if (lockText === null) {
    return { eligible: false, code: "no-lockfile", detail: `${PNPM_LOCKFILE} is not committed` };
  }

  const manifests = tree.filter((p) => p === "package.json" || p.endsWith("/package.json"));
  if (!manifests.includes("package.json")) {
    return { eligible: false, code: "no-manifest", detail: "no root package.json is committed" };
  }
  if (manifests.length > MAX_STAGED_MANIFESTS) {
    return {
      eligible: false,
      code: "too-many-manifests",
      detail: `${manifests.length} package.json files exceed the ${MAX_STAGED_MANIFESTS} staging cap`,
    };
  }
  // Root first, so the manifest list reads in the order the build consumes it.
  manifests.sort((a, b) => (a === "package.json" ? -1 : b === "package.json" ? 1 : a < b ? -1 : 1));

  if (lockText.length > MAX_INPUT_BYTES) {
    return {
      eligible: false,
      code: "unreadable-input",
      detail: `${PNPM_LOCKFILE} is ${lockText.length} bytes, past the ${MAX_INPUT_BYTES}-byte cap`,
    };
  }

  let lock: ParsedPnpmLock;
  try {
    lock = parsePnpmLock(lockText);
  } catch (err) {
    return {
      eligible: false,
      code: "unreadable-lockfile",
      detail: err instanceof PnpmLockParseError ? err.message : String(err),
    };
  }

  // pnpm reads the workspace root's `.npmrc`, not a nested one, so a nested copy neither
  // reaches the builder nor should cost the repo its base.
  const npmrcPaths = tree.filter((p) => p === ".npmrc");
  const workspaceText = tree.includes(PNPM_WORKSPACE_YAML)
    ? await git.show(args.commit, PNPM_WORKSPACE_YAML)
    : null;

  // A file the decision cannot read is a file it cannot check, and pnpm may still read it —
  // so an unparseable input is ineligible rather than treated as absent.
  let workspaceYaml: Record<string, unknown> | null = null;
  if (workspaceText !== null) {
    try {
      const parsed: unknown = parseYaml(workspaceText);
      workspaceYaml = isRecord(parsed) ? parsed : {};
    } catch (err) {
      return {
        eligible: false,
        code: "unreadable-input",
        detail: `${PNPM_WORKSPACE_YAML} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const staged: { relPath: string; text: string }[] = [
    { relPath: PNPM_LOCKFILE, text: lockText },
    ...(workspaceText !== null ? [{ relPath: PNPM_WORKSPACE_YAML, text: workspaceText }] : []),
  ];
  for (const rel of [...manifests, ...npmrcPaths]) {
    const text = await git.show(args.commit, rel);
    if (text !== null) staged.push({ relPath: rel, text });
  }

  const patches = await resolvePatches({
    lock,
    workspaceYaml,
    tree,
    read: (rel) => git.show(args.commit, rel),
    sizeOf: (rel) => git.sizeOf(args.commit, rel),
  });
  if ("eligible" in patches) return patches;
  for (const { relPath, text } of patches.files) staged.push({ relPath, text });

  for (const { relPath, text } of staged) {
    const dest = path.join(args.destDir, relPath);
    // git trees cannot carry `..`, but the staging root is a security boundary and this is
    // the one place a repo-controlled string becomes a filesystem path.
    if (dest !== path.normalize(dest) || !dest.startsWith(`${args.destDir}${path.sep}`)) {
      return {
        eligible: false,
        code: "unsafe-input-path",
        detail: `${relPath} does not stage inside the snapshot directory`,
      };
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }

  let declaredPnpm: DeclaredPnpm | null = null;
  const rootManifest = staged.find((s) => s.relPath === "package.json");
  if (rootManifest) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rootManifest.text);
    } catch (err) {
      return {
        eligible: false,
        code: "unreadable-input",
        detail: `package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    declaredPnpm = declaredPnpmFromManifest(parsed);
  }

  return {
    dir: args.destDir,
    commit: args.commit,
    lockText,
    lock,
    workspaceYaml,
    npmrc: staged
      .filter((s) => path.basename(s.relPath) === ".npmrc")
      .map((s) => ({ relPath: s.relPath, text: s.text })),
    declaredPnpm,
    manifests,
    patches: patches.entries,
  };
}

/**
 * Resolve every `patchedDependencies` entry against the commit, reading the patch bytes that
 * `decidePnpmBaseEligibility` then checks against the lockfile's hash.
 *
 * The keys are the union of the lockfile's and `pnpm-workspace.yaml`'s, because a disagreement
 * between the two is itself a refusal — measured 2026-09-21 on pnpm 12.5.1, where either half
 * alone fails a `--frozen-lockfile` install with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.
 */
async function resolvePatches(args: {
  lock: ParsedPnpmLock;
  workspaceYaml: Record<string, unknown> | null;
  tree: string[];
  read: (relPath: string) => Promise<string | null>;
  sizeOf: (relPath: string) => Promise<number | null>;
}): Promise<{ entries: StagedPatch[]; files: { relPath: string; text: string }[] } | PnpmIneligible> {
  const declared = isRecord(args.workspaceYaml?.patchedDependencies)
    ? args.workspaceYaml.patchedDependencies
    : {};
  const keys = [
    ...args.lock.patchedDependencies.map((p) => p.key),
    ...Object.keys(declared).filter((k) => !args.lock.patchedDependencies.some((p) => p.key === k)),
  ];
  if (keys.length === 0) return { entries: [], files: [] };

  const inTree = new Set(args.tree);
  const entries: StagedPatch[] = [];
  const files: { relPath: string; text: string }[] = [];
  let total = 0;
  for (const key of keys) {
    const lockHash = args.lock.patchedDependencies.find((p) => p.key === key)?.hash ?? null;
    const raw = declared[key];
    // pnpm resolves the path against the workspace root; `./x` and `x` are the same file.
    const relPath = typeof raw === "string" ? raw.replace(/^\.\//, "") : null;
    if (relPath === null || !inTree.has(relPath)) {
      entries.push({ key, relPath, sha256: null, lockHash });
      continue;
    }
    // The cap is checked against the object's SIZE before the object is read: a patch path is
    // repo-chosen and can name any committed blob, so buffering first and refusing after would
    // let one name a huge one and spend the orchestrator's memory on the way to being refused.
    const size = await args.sizeOf(relPath);
    total += size ?? MAX_PATCH_BYTES + 1;
    if (total > MAX_PATCH_BYTES) {
      return {
        eligible: false,
        code: "patched-dependency",
        detail: size === null
        ? `the patch for ${key} (${relPath}) could not be sized, so it cannot be read within the cap`
        : `the patches through ${key} exceed the ${MAX_PATCH_BYTES}-byte cap on patch input`,
      };
    }
    const text = await args.read(relPath);
    if (text === null) {
      entries.push({ key, relPath, sha256: null, lockHash });
      continue;
    }
    entries.push({ key, relPath, sha256: patchHash(text), lockHash });
    files.push({ relPath, text });
  }
  return { entries, files };
}

export interface EligibilityOptions {
  /**
   * Scopes the operator authorizes an alternative registry for, `@scope` -> registry URL. A
   * `.npmrc` may not introduce one of its own: the orchestrator decides where bytes come from
   * (plan.md section 5). Empty by default, so only the orchestrator's own registry is used.
   */
  authorizedScopeRegistries?: Record<string, string>;
  /** The registry the orchestrator resolves against; an `.npmrc` may name it but not replace it. */
  registryUrl: string;
}

/** Trailing-slash-insensitive registry comparison; npm writes both forms. */
function sameRegistry(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

function parseNpmrc(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() });
  }
  return out;
}

/**
 * The one eligibility decision, taken over the staged set before any fetch.
 *
 * Ineligible means "no base": the repo takes an ordinary private install, which is what it does
 * today. It never fails a session's own install (req 9).
 */
export function decidePnpmBaseEligibility(
  staged: StagedPnpmInputs,
  opts: EligibilityOptions,
): PnpmBaseEligibility {
  const major = staged.lock.lockfileVersion.split(".")[0];
  if (!SUPPORTED_LOCKFILE_MAJORS.has(major)) {
    return {
      eligible: false,
      code: "unsupported-lockfile-version",
      detail: `lockfileVersion ${staged.lock.lockfileVersion} is not one this builder parses`,
    };
  }

  // A repo pinning a pnpm older than the builder's store version would not fail on the base — it
  // would RECREATE the whole tree over it and reinstall privately (measured, see
  // `MIN_VERIFIED_BASE_PNPM_MAJOR`). Building a base every session of the repo then throws away is
  // worse than building none, so the decision is taken here, before any fetch.
  const declared = staged.declaredPnpm;
  if (declared !== null && declared.major < MIN_VERIFIED_BASE_PNPM_MAJOR) {
    return {
      eligible: false,
      code: "incompatible-package-manager",
      detail: `package.json declares ${declared.declaration}, whose store version differs from `
        + `the builder's, so every session would recreate the base tree instead of reading it`,
    };
  }

  // A committed `.pnpmfile.cjs`/`.mjs` costs the repo nothing: neither is ever staged, so
  // neither reaches the builder at all, and `--ignore-pnpmfile` suppresses the module body and
  // `readPackage` of both (measured on an install, with a positive control, FINDINGS.md) on
  // both builder phases (`pnpm-base-builder.ts:232,237`). The `pnpmfile` config keys below stay
  // refused — they name a path the snapshot stages for another reason.
  //
  // `configDependencies` stays out for a reason the measurement does not reach: a config
  // dependency does carry its own digest, but NOTHING HERE VERIFIES OR STAGES IT — the parser
  // reads one lockfile document (`pnpm-lockfile.ts`) and the builder stages `decision.packages`
  // alone, so admitting it would have the builder fetch plugin packages off that footing.
  if (staged.workspaceYaml && "configDependencies" in staged.workspaceYaml) {
    return {
      eligible: false,
      code: "config-dependencies",
      detail: `${PNPM_WORKSPACE_YAML} declares configDependencies, whose plugin packages this `
        + "builder does not resolve, verify or stage the way it does every other package",
    };
  }

  // A patched package's installed bytes are its verified tarball plus a patch that is committed
  // at the same immutable commit as every other input, so the result is verifiable by
  // construction: the tarball against three agreeing digests, and the patch against the sha256
  // the lockfile pins, which is what pnpm derives from the patch file's own bytes (measured
  // 2026-09-21 on 12.5.1). pnpm applies it in-process — an install with `PATH=/nonexistent`
  // still patches, so no `git`/`patch` helper is spawned — under `--ignore-scripts
  // --ignore-pnpmfile`, so admitting this runs no repo code.
  //
  // `package.json#pnpm.patchedDependencies` is not a source here: pnpm 12 does not read the
  // `pnpm` field at all (measured — it warns the key was ignored and installs unpatched), so a
  // patch declared only there reaches neither the builder nor a session on the same pnpm.
  //
  // Every failure below is one the repo's own frozen install would hit too, so refusing costs
  // the repo only the base it could not have used.
  for (const patch of staged.patches) {
    if (patch.lockHash === null) {
      return {
        eligible: false,
        code: "patched-dependency",
        detail: `${PNPM_WORKSPACE_YAML} patches ${patch.key}, which ${PNPM_LOCKFILE} pins no patch for`,
      };
    }
    if (patch.relPath === null) {
      return {
        eligible: false,
        code: "patched-dependency",
        detail: `${PNPM_LOCKFILE} pins a patch for ${patch.key} that ${PNPM_WORKSPACE_YAML} names no file for`,
      };
    }
    if (patch.sha256 === null) {
      return {
        eligible: false,
        code: "patched-dependency",
        detail: `the patch for ${patch.key} (${patch.relPath}) is not committed at this commit`,
      };
    }
    if (patch.sha256 !== patch.lockHash) {
      return {
        eligible: false,
        code: "patched-dependency",
        detail: `the committed patch for ${patch.key} (${patch.relPath}) hashes to ${patch.sha256}, `
          + `not the ${patch.lockHash} ${PNPM_LOCKFILE} pins`,
      };
    }
  }

  for (const [key, value] of Object.entries(staged.workspaceYaml ?? {})) {
    if (HOOK_CONFIG_KEYS.includes(key)) {
      return {
        eligible: false,
        code: "hook-source",
        detail: `${PNPM_WORKSPACE_YAML} sets ${key}, which points pnpm at a hook to execute`,
      };
    }
    if (layoutViolation(key, value)) {
      return {
        eligible: false,
        code: "escaping-layout",
        detail: `${PNPM_WORKSPACE_YAML} sets ${key} to ${JSON.stringify(value)}, `
          + "so the install output is not one self-contained node_modules",
      };
    }
  }

  for (const { relPath, text } of staged.npmrc) {
    for (const { key, value } of parseNpmrc(text)) {
      if (HOOK_CONFIG_KEYS.includes(key)) {
        return {
          eligible: false,
          code: "hook-source",
          detail: `${relPath} sets ${key}, which points pnpm at a hook to execute`,
        };
      }
      if (layoutViolation(key, value)) {
        return {
          eligible: false,
          code: "escaping-layout",
          detail: `${relPath} sets ${key} to ${JSON.stringify(value)}, `
            + "so the install output is not one self-contained node_modules",
        };
      }
      if (key === "registry" && !sameRegistry(value, opts.registryUrl)) {
        return {
          eligible: false,
          code: "unauthorized-registry",
          detail: `${relPath} points the default registry at ${value}, which the orchestrator did not authorize`,
        };
      }
      const scoped = /^(@[^:]+):registry$/.exec(key);
      if (scoped) {
        const authorized = opts.authorizedScopeRegistries?.[scoped[1]];
        if (authorized === undefined || !sameRegistry(authorized, value)) {
          return {
            eligible: false,
            code: "unauthorized-registry",
            detail: `${relPath} maps ${scoped[1]} to ${value}, which the orchestrator did not authorize`,
          };
        }
      }
    }
  }

  // Both halves of every edge: an ordinary `^1.0.0` specifier can RESOLVE to `link:packages/x`,
  // which happens whenever a workspace package satisfies a plain semver range, so a check that
  // reads specifiers alone lets the local edge the design excludes straight through.
  for (const { importer, name, specifier, resolved } of staged.lock.importers) {
    const local = [specifier, resolved].find((v) => LOCAL_SPECIFIER.test(v));
    if (local !== undefined) {
      return {
        eligible: false,
        code: "local-specifier",
        detail: `${importer === "." ? "the root manifest" : importer} depends on ${name} as `
          + `${local}, whose content is not a published tarball`,
      };
    }
  }
  for (const { from, name, resolved } of staged.lock.snapshotEdges) {
    if (LOCAL_SPECIFIER.test(resolved)) {
      return {
        eligible: false,
        code: "local-specifier",
        detail: `${from} depends on ${name} as ${resolved}, whose content is not a published tarball`,
      };
    }
  }

  const packages: PnpmEligible["packages"] = [];
  for (const entry of staged.lock.packages) {
    if (entry.kind !== "registry" || entry.integrity === null) {
      return {
        eligible: false,
        code: "unverifiable-entry",
        detail: `${entry.key} resolves as ${entry.kind}, which carries no registry digest to verify against`,
      };
    }
    packages.push({
      key: entry.key,
      name: entry.name,
      version: entry.version,
      integrity: entry.integrity,
    });
  }

  if (packages.length === 0) {
    // A tree with nothing in it is not worth a base, and reporting it as a failed build
    // would name the wrong cause.
    return {
      eligible: false,
      code: "no-dependencies",
      detail: `${PNPM_LOCKFILE} pins no packages, so there is nothing to share`,
    };
  }

  return { eligible: true, packages };
}

export function describeIneligible(reason: PnpmIneligible): string {
  return `${reason.code}: ${reason.detail}`;
}
