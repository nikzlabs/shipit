/**
 * Content hash of a session's dependency input files (docs/197 Part 1).
 *
 * The stamped install marker (`install-marker.ts`) skips `agent.install` only on
 * an exact match of the source commit, runtime, and install commands. That is
 * correct but too narrow: two different commits that touch only non-dependency
 * files (a README edit, a source refactor) have identical `package.json` /
 * lockfiles, so their dependency trees are byte-for-byte the same — yet the
 * commit-keyed marker forces a full reinstall on the second. The **content key**
 * widens the skip: when the dependency *input* files hash identically, the deps
 * are already correct regardless of which commit produced them.
 *
 * `depsHash` is a sha256 over the ordered `(relpath, bytes)` of the per-ecosystem
 * dependency input files. It feeds the OR in `markerMatches`: skip when
 * runtime + commands agree AND (commit matches OR depsHash matches).
 *
 * **Codegen safety.** The content path is only active when the install is a
 * recognized *pure dependency install* — `npm install|ci`, `pnpm install`,
 * `yarn install`, `pip install -r`, `uv sync`, `uv pip install -r` / `uv pip
 * sync`, plus input-free virtualenv creation (`uv venv`, `python3 -m venv`)
 * which consumes no manifest (common flags tolerated). A repo
 * whose `agent.install` runs codegen, a build, or anything that consumes files
 * beyond the manifest could change its output without the hashed inputs moving,
 * so for those we fall back to commit-only (the hash resolves to `null`, which
 * never matches — a missing/`null` hash can only ever cause a reinstall, never a
 * wrong skip). An explicit `agent.install-inputs: [files…]` in `shipit.yaml`
 * opts back in and **replaces** the default per-command input set.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The dependency input files a recognized pure-install command consumes, or
 * `null` when the command is not a recognized pure dependency install (which
 * disables content-keying for the whole install — see {@link resolveDepsHashInputs}).
 *
 * Only the canonical "install everything from the manifest/lockfile" form is
 * recognized; a command that names a package (`npm install lodash`), runs a
 * subcommand (`yarn add`), or takes a value-bearing flag that looks like a
 * positional is treated as unrecognized and falls back to commit-only. Erring
 * toward "unrecognized" is the safe direction — it only ever costs a reinstall.
 */
export function depInputsForCommand(command: string): string[] | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const tool = tokens[0];
  const args = tokens.slice(1);
  // Positional (non-flag) words after the tool. For npm/pnpm/yarn/uv the only
  // legitimate positional is the subcommand; a value-bearing flag (e.g.
  // `--prefix foo`) leaves `foo` as a positional and is conservatively rejected.
  // (venv creation is the exception — it takes an optional path positional; see
  // `isVenvCreation`.)
  const positionals = args.filter((t) => !t.startsWith("-"));

  switch (tool) {
    case "npm":
      return isBareSubcommand(positionals, ["install", "ci", "i"])
        ? ["package.json", "package-lock.json"]
        : null;
    case "pnpm":
      return isBareSubcommand(positionals, ["install", "i"])
        ? ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]
        : null;
    case "yarn":
      // Yarn classic: bare `yarn` or `yarn install` installs from the manifest;
      // any other subcommand (add, run, …) is not a pure manifest install.
      if (positionals.length === 0) return ["package.json", "yarn.lock"];
      return isBareSubcommand(positionals, ["install"]) ? ["package.json", "yarn.lock"] : null;
    case "pip":
    case "pip3":
      return pipRequirementInputs(args);
    case "uv":
      // `uv sync` → pyproject + lock; `uv venv [path]` → input-free; `uv pip
      // install -r` / `uv pip sync <file>` → same requirements-file inputs as pip.
      if (positionals[0] === "sync") {
        return isBareSubcommand(positionals, ["sync"]) ? ["pyproject.toml", "uv.lock"] : null;
      }
      if (isVenvCreation(positionals)) return [];
      if (positionals[0] === "pip") return uvPipInputs(args);
      return null;
    case "python":
    case "python3":
      // `python3 -m venv [path]` — stdlib virtualenv creation, input-free like
      // `uv venv`. (`python -m venv` leaves `venv` as a positional after the
      // `-m` value, alongside the optional path.)
      return isVenvCreation(positionals) ? [] : null;
    default:
      return null;
  }
}

/** True when the only positional is exactly one of the accepted subcommands. */
function isBareSubcommand(positionals: string[], accepted: string[]): boolean {
  return positionals.length === 1 && accepted.includes(positionals[0]);
}

/**
 * `uv venv [path]` / `python3 -m venv [path]` — virtualenv creation. These
 * consume **no** dependency manifest, so they are a recognized *input-free*
 * install: they must NOT disable the content path (returning `[]`, not `null`),
 * and they contribute no files to the hash. The subcommand takes an optional
 * positional path (`.venv`), so we accept the `venv` positional plus at most one
 * trailing path positional; a value-bearing flag that leaves extra positionals
 * (e.g. `--python 3.12 .venv`) is conservatively rejected (→ null).
 */
function isVenvCreation(positionals: string[]): boolean {
  return positionals[0] === "venv" && positionals.length <= 2;
}

/**
 * `uv pip install -r <file>` / `uv pip sync <file>`, given the token list after
 * `uv` (`['pip', <sub>, …]`). `install` reuses pip's requirements extraction
 * (`-r`/`--requirement`, so ad-hoc package args like `uv pip install foo` →
 * null, same as bare pip); `sync` takes requirements files as bare positionals
 * (pip-tools style). Any other subcommand, or no file, → null.
 */
function uvPipInputs(args: string[]): string[] | null {
  const afterPip = args.slice(1); // [<sub>, …]
  if (afterPip[0] === "install") return pipRequirementInputs(afterPip);
  if (afterPip[0] === "sync") {
    const files = afterPip.slice(1).filter((a) => !a.startsWith("-"));
    return files.length > 0 ? files : null;
  }
  return null;
}

/**
 * Parse `pip install -r <file> [-r <file> …]`, tolerating other flags
 * (`--no-cache-dir`, `--upgrade`, …). Returns the requirement files, or `null`
 * when this is not a manifest-driven install: no `install` subcommand, no `-r`
 * file, or a bare package positional (`pip install flask`) — none of which are
 * fully described by hashing a requirements file.
 */
function pipRequirementInputs(args: string[]): string[] | null {
  if (args[0] !== "install") return null;
  const files: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "-r" || a === "--requirement") {
      const f = args[i + 1];
      if (!f || f.startsWith("-")) return null;
      files.push(f);
      i++;
    } else if (a.startsWith("--requirement=")) {
      files.push(a.slice("--requirement=".length));
    } else if (a.startsWith("-r") && a.length > 2) {
      files.push(a.slice(2));
    } else if (a.startsWith("-")) {
      continue; // tolerate other flags
    } else {
      return null; // a bare package positional → not a pure requirements install
    }
  }
  return files.length > 0 ? files : null;
}

/**
 * Resolve the set of dependency input files to hash for an install, or `null`
 * to disable content-keying (commit-only).
 *
 * - `installInputs` (from `agent.install-inputs`) is an explicit override: when
 *   non-`null` it **replaces** the default per-command set, opting back in
 *   regardless of whether the commands are recognized. An explicit empty list
 *   yields `[]` → no inputs → `null` hash (content-keying off).
 * - Otherwise the set is the union of {@link depInputsForCommand} across every
 *   command. If **any** command is unrecognized the whole install falls back to
 *   commit-only (`null`) — one codegen step taints the content key.
 */
export function resolveDepsHashInputs(
  installCommands: string[],
  installInputs: string[] | null,
): string[] | null {
  if (installInputs !== null) return installInputs;

  const files = new Set<string>();
  for (const cmd of installCommands) {
    const inputs = depInputsForCommand(cmd);
    if (inputs === null) return null;
    for (const f of inputs) files.add(f);
  }
  return files.size > 0 ? [...files] : null;
}

/**
 * sha256 over the ordered `(relpath, bytes)` of the given input files that
 * exist under `workspaceDir`. Absent files are skipped (so adding a lockfile
 * later changes the hash, as it should). Returns `null` when **no** input file
 * exists — there is nothing to content-key, so the caller stays commit-only.
 *
 * The relpath and byte length are mixed in alongside the bytes so two files
 * can't be transposed or concatenated into a colliding digest.
 */
export function computeDepsHash(workspaceDir: string, inputs: string[]): string | null {
  const hash = crypto.createHash("sha256");
  let any = false;
  for (const rel of [...inputs].sort()) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(workspaceDir, rel));
    } catch {
      continue; // absent input — does not contribute to the digest
    }
    any = true;
    hash.update(rel);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return any ? hash.digest("hex") : null;
}

/**
 * Compute the install marker's `depsHash` for a workspace: resolve the input
 * set (honoring `install-inputs` and the command allowlist), then hash it.
 * Returns `null` whenever content-keying is off or there is nothing to hash —
 * in which case the marker falls back to commit-only matching.
 */
export function computeInstallDepsHash(
  workspaceDir: string,
  installCommands: string[],
  installInputs: string[] | null,
): string | null {
  const inputs = resolveDepsHashInputs(installCommands, installInputs);
  if (inputs === null) return null;
  return computeDepsHash(workspaceDir, inputs);
}
