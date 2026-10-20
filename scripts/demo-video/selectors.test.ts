import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SELECTORS } from "./selectors.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SELECTORS_PATH = path.join(REPO_ROOT, "scripts/demo-video/selectors.mjs");
const CLIENT_DIR = path.join(REPO_ROOT, "src/client");

// Test code is left out, so a test that still names a renamed test ID cannot keep this green.
const CLIENT_SOURCE = readdirSync(CLIENT_DIR, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.tsx?$/.test(file) && !/(\.test|\.testing|test-setup)\.tsx?$/.test(file))
  .map((file) => readFileSync(path.join(CLIENT_DIR, file), "utf8"))
  .join("\n");

// Stands in for a part the client fills in at run time: `${…}` in a template literal.
const RUNTIME = "\u0000";

// A whole string or template literal, or JSX text with the whitespace around it.
const OPEN = "(?:[\"'`]|>\\s*)";
const CLOSE = "(?:[\"'`]|\\s*<)";

interface Expected {
  value: string;
  pattern: RegExp;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literal(value: string, match: "whole" | "prefix" | "suffix" = "whole"): Expected {
  const body = value.split(RUNTIME).map(escapeRegExp).join("\\$\\{[^}]+\\}");
  const open = match === "suffix" ? "" : OPEN;
  const close = match === "prefix" ? "" : CLOSE;
  return { value: value.replaceAll(RUNTIME, "${…}"), pattern: new RegExp(open + body + close) };
}

function attributeName(name: string): Expected {
  return { value: name, pattern: new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`) };
}

const ATTRIBUTE = /^\s*([\w-]+)\s*(?:([\^$]?)=\s*(?:"([^"]*)"|'([^']*)'))?\s*$/;

/** `[name]` checks the attribute name; `[name="v"]`, `^=` and `$=` check the value. */
function fromSelector(selector: string): Expected[] {
  return [...selector.matchAll(/\[([^\]]*)\]/g)].map(([brackets, body]) => {
    const parts = ATTRIBUTE.exec(body);
    if (!parts) throw new Error(`unsupported attribute selector ${brackets}`);
    const [, name, operator, doubleQuoted, singleQuoted] = parts;
    const value = doubleQuoted ?? singleQuoted;
    if (value === undefined) return attributeName(name);
    return literal(value, operator === "^" ? "prefix" : operator === "$" ? "suffix" : "whole");
  });
}

// Plain strings that are visible text, not selectors.
const TEXT_ENTRIES = new Set(["composerReadyPlaceholder", "newSessionRowText"]);

// No fixed value to check: `transcript` is Tailwind classes only, and the client sets
// `fileTreeEntry`'s `title` to the whole file path.
const UNCHECKED_ENTRIES = new Set(["transcript", "fileTreeEntry"]);

// Function entries, called with the values their comments name.
const FUNCTION_ENTRIES: Record<string, () => Expected[]> = {
  permissionModeLabel: () => {
    const fixed = SELECTORS.permissionModeLabel(RUNTIME);
    const labels = ["auto", "guarded", "plan"].map((mode) =>
      literal(SELECTORS.permissionModeLabel(mode).slice(fixed.indexOf(RUNTIME))),
    );
    return [literal(fixed), ...labels];
  },
  repoGroupHeader: () =>
    ["Expand", "Collapse"].flatMap((state) => fromSelector(SELECTORS.repoGroupHeader(RUNTIME, state))),
  paneTab: () => Object.values(SELECTORS.paneTabLabels).flatMap((label) => fromSelector(SELECTORS.paneTab(label))),
};

function expectedFor(key: string, value: unknown): Expected[] {
  if (key in FUNCTION_ENTRIES) return FUNCTION_ENTRIES[key]();
  if (Array.isArray(value)) return value.map((text) => literal(text));
  if (typeof value === "object" && value !== null) return Object.values(value).map((text) => literal(text));
  if (typeof value === "string") return TEXT_ENTRIES.has(key) ? [literal(value)] : fromSelector(value);
  return [];
}

describe("demo-video selector map", () => {
  it("keeps the contract the external pipeline loads it by", () => {
    expect(SELECTORS).toBeTypeOf("object");
    expect(SELECTORS.paneTabLabels?.constructor).toBe(Object);
    const source = readFileSync(SELECTORS_PATH, "utf8");
    expect(ts.preProcessFile(source, true, true).importedFiles).toEqual([]);
    // preProcessFile records only literal specifiers, so also reject `import(target)`.
    expect(source).not.toMatch(/\b(import|require)\s*\(/);
  });

  const checked = Object.entries(SELECTORS).filter(([key]) => !UNCHECKED_ENTRIES.has(key));

  it.each(checked)("%s names only values that still appear in src/client", (key, value) => {
    const expected = expectedFor(key, value);
    expect(expected, "no value to check: handle the entry here, or add it to UNCHECKED_ENTRIES").not.toEqual([]);
    const missing = expected.filter(({ pattern }) => !pattern.test(CLIENT_SOURCE)).map(({ value }) => value);
    expect(missing).toEqual([]);
  });
});
