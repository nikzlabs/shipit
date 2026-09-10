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
  raw: string;
  /** null means unsupported. */
  spec: RangeSpec | null;
}

/** A parsed range: a union of comparator sets (`||`), each an intersection. */
export type RangeSpec = Comparator[][];

export interface Comparator {
  op: ">=" | ">" | "<=" | "<" | "=";
  version: NodeVersion;
}

export function parseVersion(text: string): NodeVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareVersions(a: NodeVersion, b: NodeVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function formatVersion(v: NodeVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

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
    if (!/^(0|[1-9]\d*)$/.test(part)) return null;
    nums.push(Number(part));
  }
  const [major, minor = null, patch = null] = nums;
  if (major === null || major === undefined) return null;
  if (minor === null && patch !== null) return null;
  return { major, minor, patch };
}

const ANY: Comparator[] = [{ op: ">=", version: { major: 0, minor: 0, patch: 0 } }];

export function parseRange(text: string): RangeSpec | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "x" || trimmed === "X") return [ANY];

  const unions = trimmed.split("||");
  const spec: Comparator[][] = [];
  for (const union of unions) {
    const raw = union.trim().split(/\s+/).filter(Boolean);
    if (raw.length === 0) return null;
    if (raw.includes("-")) return null;
    const tokens = joinLooseOperators(raw);
    if (!tokens) return null;
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

function joinLooseOperators(tokens: string[]): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^(>=|<=|>|<|=|\^|~)$/.test(token)) {
      const operand = tokens[i + 1];
      if (operand === undefined) return null;
      out.push(token + operand);
      i++;
      continue;
    }
    out.push(token);
  }
  return out;
}

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
      // The ^0.x special case is not implemented.
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

export function pickBest(available: NodeVersion[], spec: RangeSpec): NodeVersion | null {
  let best: NodeVersion | null = null;
  for (const v of available) {
    if (!satisfies(v, spec)) continue;
    if (!best || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

/** An unsupported .nvmrc still takes precedence over engines.node. */
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
