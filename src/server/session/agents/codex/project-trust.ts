// Codex 0.153.2 requires trust in the config file; -c overrides did not work.
// Trust the directory containing .codex. This enables repo hooks as well as config.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getErrorMessage } from "../../../shared/utils.js";

function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export type CodexProjectsState = "absent" | "declared" | "ambiguous";

function parseDottedKey(text: string): string[] | null {
  const segments: string[] = [];
  let rest = text.trim();
  for (;;) {
    let segment: string;
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      let i = 1;
      let value = "";
      for (; i < rest.length && rest[i] !== quote; i++) {
        if (quote === '"' && rest[i] === "\\") {
          const next = rest[++i];
          if (next === undefined) return null;
          value += next === "\\" || next === '"' ? next : `\\${next}`;
          continue;
        }
        value += rest[i];
      }
      if (rest[i] !== quote) return null;
      segment = value;
      rest = rest.slice(i + 1).trimStart();
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(rest);
      if (!match) return null;
      segment = match[0];
      rest = rest.slice(match[0].length).trimStart();
    }
    segments.push(segment);
    if (rest === "") return segments;
    if (!rest.startsWith(".")) return null;
    rest = rest.slice(1).trimStart();
  }
}

function tableHeaderBody(line: string): string | null {
  if (!line.startsWith("[")) return null;
  let quote: string | null = null;
  for (let i = 1; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "]") {
      const after = line.slice(i + 1).trim();
      if (after !== "" && !after.startsWith("#")) return null;
      return line.slice(1, i);
    }
  }
  return null;
}

function mentionsProjects(line: string): boolean {
  return /(^|[[.\s"'])projects([\s.\]"']|$)/.test(line);
}

export function codexProjectsState(existing: string, dir: string): CodexProjectsState {
  let state: CodexProjectsState = "absent";
  let sawTableHeader = false;
  for (const raw of existing.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.startsWith("[")) {
      sawTableHeader = true;
      if (line.startsWith("[[")) {
        if (mentionsProjects(line)) state = "ambiguous";
        continue;
      }
      const body = tableHeaderBody(line);
      if (body === null) {
        if (mentionsProjects(line)) state = "ambiguous";
        continue;
      }
      const segments = parseDottedKey(body);
      if (segments === null) {
        if (mentionsProjects(line)) state = "ambiguous";
        continue;
      }
      if (segments[0] !== "projects") continue;
      // We do not parse table bodies; appending could duplicate a key and invalidate TOML.
      if (segments.length === 1) return "ambiguous";
      if (segments[1] === dir) return "declared";
      continue;
    }

    // Dotted keys after a header belong to that table, not the root.
    if (sawTableHeader || !mentionsProjects(line)) continue;
    const eq = line.indexOf("=");
    if (eq === -1) { state = "ambiguous"; continue; }
    const segments = parseDottedKey(line.slice(0, eq));
    if (segments === null) { state = "ambiguous"; continue; }
    if (segments[0] === "projects" && (segments.length === 1 || segments[1] === dir)) {
      return "declared";
    }
  }
  return state;
}

// Preserve existing trust decisions and append outside the rewritten MCP block.
export function ensureCodexProjectTrusted(configDir: string, projectDir: string): boolean {
  const dir = path.resolve(projectDir);
  const configPath = path.join(configDir, "config.toml");
  if (!existsSync(configDir)) return false;
  try {
    let existing = "";
    try {
      existing = readFileSync(configPath, "utf-8");
    } catch { /* no config yet */ }

    if (codexProjectsState(existing, dir) !== "absent") return false;

    const block = [
      "# ShipIt trusts the workspace it spawns Codex in, so the repo's own",
      "# .codex/ config, hooks and exec policies load. To opt out, KEEP this",
      "# table and set trust_level = \"untrusted\" — ShipIt only ever adds the",
      "# table when the config declares no `projects` entry for the directory,",
      "# so deleting it just brings it back on the next turn.",
      `[projects.${tomlBasicString(dir)}]`,
      `trust_level = "trusted"`,
      "",
    ].join("\n");

    writeFileSync(configPath, `${existing.trimEnd()}${existing.trimEnd() ? "\n\n" : ""}${block}`);
    return true;
  } catch (err) {
    console.warn(`[codex] could not trust ${dir} in ${configPath}: ${getErrorMessage(err)}`);
    return false;
  }
}
