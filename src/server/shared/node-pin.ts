/**
 * Node version pin resolution (docs/248, nikzlabs/shipit#1728).
 *
 * A repo pins the Node major it targets; the session-worker image bakes its own
 * (`node:24-slim` today). Without this, `node -v` in a session disagrees with
 * the project's `.nvmrc`, native addons compile against the wrong ABI, and the
 * Node that installs `node_modules` disagrees with the Node a Compose preview
 * service pins for the same mounted workspace.
 *
 * This module is the **pure** half: read the pin, decide whether the Node
 * already running satisfies it, and pick the best candidate from a list of
 * available versions. Downloading and installing lives in
 * `session/node-runtime.ts`, which is the only part that touches the network
 * and the filesystem outside the workspace.
 *
 * Pin sources, in precedence order (requirement 3 — deliberately only these
 * two; `.node-version`, `volta.node`, `mise.toml` and `.tool-versions` are NOT
 * read):
 *   1. `.nvmrc` at the workspace root — wins, because it pins a version.
 *   2. `package.json` `engines.node` — usually a range, so it is a constraint
 *      rather than a choice.
 *
 * The range grammar implemented here is the npm-`engines` subset that actually
 * appears in the wild — `>=`, `>`, `<=`, `<`, `=`, `^`, `~`, x-ranges, `*`,
 * space-separated intersections, and `||` unions. It is deliberately NOT a
 * general semver implementation: the `semver` package would be a new runtime
 * dependency under the 7-day-cooldown policy for a job whose entire input space
 * is "which Node major does this repo target", and an unparseable range is a
 * *reported* outcome here (`unsupported`), never a wrong one.
 */

import fs from "node:fs";
import path from "node:path";

import type { NodePinSource } from "./types/node-runtime-types.js";

export interface NodeVersion {
  major: number;
  minor: number;
  patch: number;
}

export type { NodePinSource };

export interface NodePin {
  source: NodePinSource;
  /** The literal text as written in the repo, for display in diagnostics. */
  raw: string;
  /**
   * The parsed constraint, or `null` when the text is a form we don't
   * implement (`lts/jod`, `node`, `stable`, a git URL, …). A null spec is
   * surfaced as an `unsupported` outcome rather than silently ignored.
   */
  spec: RangeSpec | null;
}

/** A parsed range: a union of comparator sets (`||`), each an intersection. */
export type RangeSpec = Comparator[][];

export interface Comparator {
  op: ">=" | ">" | "<=" | "<" | "=";
  version: NodeVersion;
}

// ---------------------------------------------------------------------------
// Version parsing / comparison
// ---------------------------------------------------------------------------

/** Parse `v22.20.1` / `22.20.1` / `22.20.1-rc.1`. Returns null if not a version. */
export function parseVersion(text: string): NodeVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Standard semver ordering. Negative when `a < b`. */
export function compareVersions(a: NodeVersion, b: NodeVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function formatVersion(v: NodeVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Parse a possibly-partial version (`20`, `20.1`, `20.x`, `20.1.2`). `x`/`X`/`*`
 * in a position means "unspecified", matching npm's x-range convention.
 */
function parsePartial(text: string): { major: number; minor: number | null; patch: number | null } | null {
  const cleaned = text.trim().replace(/^v/, "");
  if (cleaned === "") return null;
  const parts = cleaned.split(".");
  if (parts.length > 3) return null;
  const nums: (number | null)[] = [];
  for (const part of parts) {
    if (/^[xX*]$/.test(part)) {
      nums.push(null);
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  const [major, minor = null, patch = null] = nums;
  // `x.2.3` is meaningless — a wildcard major with a concrete minor.
  if (major === null || major === undefined) return null;
  return { major, minor, patch };
}

// ---------------------------------------------------------------------------
// Range parsing
// ---------------------------------------------------------------------------

/** The always-true comparator set: `>=0.0.0`. */
const ANY: Comparator[] = [{ op: ">=", version: { major: 0, minor: 0, patch: 0 } }];

/**
 * Parse an npm-style range into a union of comparator sets. Returns null when
 * any part of the range uses a form we don't implement, so the caller can
 * report `unsupported` instead of quietly matching the wrong thing.
 */
export function parseRange(text: string): RangeSpec | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "x" || trimmed === "X") return [ANY];

  const unions = trimmed.split("||");
  const spec: Comparator[][] = [];
  for (const union of unions) {
    const tokens = union.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    // A hyphen range (`18 - 22`) arrives as three tokens; not implemented.
    if (tokens.includes("-")) return null;
    const set: Comparator[] = [];
    for (const token of tokens) {
      const comparators = parseComparator(token);
      if (!comparators) return null;
      set.push(...comparators);
    }
    spec.push(set);
  }
  return spec;
}

/** Expand a single token (`^20.1`, `>=18`, `22.x`) into concrete comparators. */
function parseComparator(token: string): Comparator[] | null {
  const opMatch = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (!opMatch) return null;
  const op = opMatch[1] ?? "";
  const partial = parsePartial(opMatch[2]);
  if (!partial) return null;

  const { major, minor, patch } = partial;
  const lower: NodeVersion = { major, minor: minor ?? 0, patch: patch ?? 0 };

  switch (op) {
    case ">=":
      return [{ op: ">=", version: lower }];
    case ">":
      // `>20` means "after everything in the 20 line" when the minor/patch are
      // unspecified — npm's x-range semantics, not `>20.0.0`.
      if (minor === null) return [{ op: ">=", version: { major: major + 1, minor: 0, patch: 0 } }];
      if (patch === null) return [{ op: ">=", version: { major, minor: minor + 1, patch: 0 } }];
      return [{ op: ">", version: lower }];
    case "<=":
      if (minor === null) return [{ op: "<", version: { major: major + 1, minor: 0, patch: 0 } }];
      if (patch === null) return [{ op: "<", version: { major, minor: minor + 1, patch: 0 } }];
      return [{ op: "<=", version: lower }];
    case "<":
      return [{ op: "<", version: lower }];
    case "^":
      // Node majors are never 0, so the `^0.x` special case doesn't arise.
      return [
        { op: ">=", version: lower },
        { op: "<", version: { major: major + 1, minor: 0, patch: 0 } },
      ];
    case "~": {
      const upper: NodeVersion =
        minor === null
          ? { major: major + 1, minor: 0, patch: 0 }
          : { major, minor: minor + 1, patch: 0 };
      return [
        { op: ">=", version: lower },
        { op: "<", version: upper },
      ];
    }
    default: {
      // Bare or `=`-prefixed. A partial is an x-range; a full version is exact.
      if (minor === null) {
        return [
          { op: ">=", version: lower },
          { op: "<", version: { major: major + 1, minor: 0, patch: 0 } },
        ];
      }
      if (patch === null) {
        return [
          { op: ">=", version: lower },
          { op: "<", version: { major, minor: minor + 1, patch: 0 } },
        ];
      }
      return [{ op: "=", version: lower }];
    }
  }
}

/** Whether `version` satisfies the parsed range. */
export function satisfies(version: NodeVersion, spec: RangeSpec): boolean {
  return spec.some((set) => set.every((c) => matchesComparator(version, c)));
}

function matchesComparator(v: NodeVersion, c: Comparator): boolean {
  const cmp = compareVersions(v, c.version);
  switch (c.op) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
  }
}

/** The newest version in `available` that satisfies the range, or null. */
export function pickBest(available: NodeVersion[], spec: RangeSpec): NodeVersion | null {
  let best: NodeVersion | null = null;
  for (const v of available) {
    if (!satisfies(v, spec)) continue;
    if (!best || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Reading the pin out of a workspace
// ---------------------------------------------------------------------------

/**
 * Read the repo's Node pin. `.nvmrc` wins over `engines.node` (requirement 3).
 * Returns null when the repo pins nothing at all — the common case, and the one
 * where this whole feature must stay invisible.
 *
 * A `.nvmrc` that exists but holds an unsupported form (`lts/jod`, `node`) is
 * returned with a null `spec` rather than falling through to `engines.node`:
 * the repo did express a preference, and silently honoring a *different* source
 * would be more surprising than reporting that we couldn't read this one.
 */
export function readNodePin(workspaceDir: string): NodePin | null {
  const nvmrc = readNvmrc(workspaceDir);
  if (nvmrc) return nvmrc;
  return readEnginesNode(workspaceDir);
}

function readNvmrc(workspaceDir: string): NodePin | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(workspaceDir, ".nvmrc"), "utf-8");
  } catch {
    return null;
  }
  // nvm reads the first non-empty line; `#` comments are a de-facto convention.
  const raw = text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .find((line) => line !== "");
  if (!raw) return null;
  return { source: ".nvmrc", raw, spec: parseRange(raw) };
}

function readEnginesNode(workspaceDir: string): NodePin | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(workspaceDir, "package.json"), "utf-8"));
  } catch {
    return null;
  }
  const engines = (parsed as { engines?: unknown } | null)?.engines;
  const node = (engines as { node?: unknown } | undefined)?.node;
  if (typeof node !== "string" || node.trim() === "") return null;
  return { source: "engines.node", raw: node.trim(), spec: parseRange(node) };
}
