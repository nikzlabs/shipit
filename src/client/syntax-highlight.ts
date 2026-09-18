/**
 * The one place ShipIt decides what highlight.js knows about.
 *
 * **Why this module exists.** `import hljs from "highlight.js"` pulls the full
 * build — 192 language grammars, ~1.0 MB minified — into the main chunk, and
 * every grammar in it is also a grammar `highlightAuto` has to run. A production
 * trace of the chat transcript measured `highlightAuto` at 52% of the whole
 * profile: 35 synchronous calls inside React renders at ~274 ms each, because
 * auto-detection highlights the text once per registered language and compares
 * relevance scores. Registering a bounded set fixes both halves at once — a
 * smaller download, and a cheaper fallback for the one call site that still has
 * to guess.
 *
 * **Two lists, not one.** {@link HIGHLIGHT_LANGUAGES} is what is *registered* —
 * what a fence may name. {@link AUTO_DETECT_SUBSET} is what is *guessed* across
 * when a fence names nothing, and it is deliberately smaller: three registered
 * grammars are quadratic on prose and cost ~95% of a guess, so they are
 * excluded from guessing while staying available by name.
 *
 * **The behaviour changes this carries.** A language absent from
 * {@link HIGHLIGHT_LANGUAGES} is no longer highlighted at all: a ```haskell fence
 * renders as plain monospace rather than colored (see {@link highlightCode} for
 * why plain rather than guessed). An **unlabelled** fence holding C, C++ or C#
 * is no longer recognised as such — it is colored as whichever of the remaining
 * grammars comes closest — and one longer than {@link AUTO_DETECT_MAX_CHARS} is
 * not guessed at at all. Those are the deliberate trades, and these two lists
 * plus that bound are the whole of them.
 *
 * Prefer {@link languageFromPath} over auto-detection wherever a file path is in
 * hand. Measured on 12 KB of ShipIt source: `highlight` with a known language is
 * 4.1 ms, `highlightAuto` over this subset is 19.6 ms, and `highlightAuto` over
 * all 192 was 248.9 ms.
 */

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGE_DEFINITIONS = {
  bash,
  c,
  cpp,
  csharp,
  css,
  dart,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  plaintext,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
} as const;

for (const [name, definition] of Object.entries(LANGUAGE_DEFINITIONS)) {
  hljs.registerLanguage(name, definition);
}

export const HIGHLIGHT_LANGUAGES: readonly string[] = Object.keys(LANGUAGE_DEFINITIONS);

type RegisteredLanguage = keyof typeof LANGUAGE_DEFINITIONS;

const AUTO_DETECT_SUBSET: RegisteredLanguage[] = [
  "bash", "css", "dart", "diff", "dockerfile", "go", "ini", "java",
  "javascript", "json", "kotlin", "markdown", "php", "plaintext", "python",
  "ruby", "rust", "scss", "shell", "sql", "swift", "typescript", "xml", "yaml",
];

/**
 * Above this many characters, an unlabelled block is not guessed at.
 *
 * A backstop, not the fix: dropping the three grammars above solves the case we
 * measured, and this stops the *next* one — a grammar that turns quadratic on
 * some input nobody has tried, or a pathological input to a linear one. A guess
 * is inherently N passes over the whole block, so its cost can only be bounded
 * by bounding what goes in.
 *
 * 12,000 comes from the worst prose found: the 24 grammars above cost ~90 ms at
 * 12 KB, ~138 ms at 16 KB and ~255 ms at 24 KB. It keeps the worst case inside
 * roughly a tenth of a second while sitting far above any ordinary unlabelled
 * fence.
 *
 * **A named language is deliberately not capped — and NOT because naming one
 * makes it linear.** It does not: `highlight` and `highlightAuto` run the same
 * `_highlight` routine, so explicit `c`/`cpp`/`csharp` on the prose above is
 * quadratic too (16 KB: c 7.0 s, cpp 5.1 s, csharp 4.4 s). What makes the named
 * path safe in practice is the *content*, not the call: on real C source those
 * same grammars are near-linear — 200 KB costs c 744 ms, cpp 321 ms,
 * csharp 219 ms — because actual code has the punctuation whose absence is what
 * backtracks.
 *
 * So the exposure that remains is prose-shaped text explicitly labelled C, C++
 * or C#, and no size cap addresses it: the bound would have to be ~4,000
 * characters to help, which would strip highlighting from ordinary C files to
 * defend against mislabelled prose. Capping the guess, where the caller told us
 * nothing and we pay N passes, is the part worth bounding.
 */
const AUTO_DETECT_MAX_CHARS = 12_000;

/** Test-only: the auto-detect policy, so a guard cannot drift from it. */
export const AUTO_DETECT = {
  LANGUAGES: AUTO_DETECT_SUBSET as readonly string[],
  MAX_CHARS: AUTO_DETECT_MAX_CHARS,
} as const;

const EXTENSION_LANGUAGES: Record<string, RegisteredLanguage> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  css: "css", scss: "scss",
  py: "python", rb: "ruby", go: "go", rs: "rust", php: "php",
  java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", cs: "csharp", dart: "dart",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  sh: "bash", bash: "bash", zsh: "bash",
  md: "markdown", markdown: "markdown",
  yaml: "yaml", yml: "yaml",
  sql: "sql",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  diff: "diff", patch: "diff",
  txt: "plaintext",
};

const FILENAME_LANGUAGES: Record<string, RegisteredLanguage> = {
  dockerfile: "dockerfile",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".env": "ini",
};

/**
 * The highlight.js language for a file path, or `null` when nothing is known.
 *
 * `null` means "do not guess from the path" — the caller decides whether to fall
 * back to auto-detection or to plain text.
 */
export function languageFromPath(filePath: string): RegisteredLanguage | null {
  const fileName = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (!fileName) return null;

  const byName = FILENAME_LANGUAGES[fileName];
  if (byName) return byName;

  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1) : "";
  const byExtension = EXTENSION_LANGUAGES[ext];
  if (byExtension) return byExtension;

  const stem = fileName.startsWith(".")
    ? `.${fileName.slice(1).split(".")[0]}`
    : (fileName.split(".")[0] ?? "");
  return FILENAME_LANGUAGES[stem] ?? null;
}

/**
 * Highlight `code` as `language`, or auto-detect when no language is known.
 *
 * The three outcomes are deliberately distinct, and the middle one is the whole
 * point of naming a language:
 *
 * - **A registered language** → highlighted with that grammar, one pass.
 * - **A language nothing answers to** (a ```haskell fence) → `null`, rendered as
 *   plain text. Guessing here would be wrong twice over: it colors the block as
 *   some *other* language, and it pays for 26 speculative passes to do it. The
 *   caller told us what this is; not having the grammar does not license us to
 *   overrule them.
 * - **No language at all** (`null`, `undefined`, `""`) → auto-detected across
 *   {@link AUTO_DETECT_SUBSET}, because there is nothing else to go on — unless
 *   the block is longer than {@link AUTO_DETECT_MAX_CHARS}, in which case `null`
 *   again: past that size, guessing is worth less than the frame it costs.
 *
 * Also `null` when highlighting throws — highlighting is decoration, and a
 * grammar that chokes on one file must not take the transcript with it.
 */
export function highlightCode(code: string, language?: string | null): string | null {
  try {
    if (language) {

      // NOT because a named grammar is a linear pass: it is the same

      return hljs.getLanguage(language) ? hljs.highlight(code, { language }).value : null;
    }
    if (code.length > AUTO_DETECT_MAX_CHARS) return null;

    // `highlightAuto` only filters and maps it, never mutates.
    return hljs.highlightAuto(code, AUTO_DETECT_SUBSET).value;
  } catch {
    return null;
  }
}

export { hljs };
