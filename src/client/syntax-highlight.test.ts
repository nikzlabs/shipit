import { describe, it, expect } from "vitest";
import { AUTO_DETECT, hljs, HIGHLIGHT_LANGUAGES, highlightCode, languageFromPath } from "./syntax-highlight.js";

/**
 * Prose that the `c`, `cpp` and `csharp` grammars are quadratic on: words with
 * no sentence punctuation to break the run, which their declaration matchers
 * backtrack across. Sentence-ending punctuation makes the same length cheap, so
 * a guard built on ordinary sentences would pass no matter what is registered.
 */
function pathologicalProse(chars: number): string {
  const unit = "the quick brown fox jumps over the lazy dog ";
  let text = "";
  while (text.length < chars) text += unit;
  return text.slice(0, chars);
}

describe("HIGHLIGHT_LANGUAGES", () => {
  it("registers every language it names", () => {
    for (const name of HIGHLIGHT_LANGUAGES) {
      expect(hljs.getLanguage(name), `${name} is listed but not registered`).toBeDefined();
    }
  });

  it("is a bounded subset, not the full highlight.js build", () => {
    // The whole point of the core build: 192 grammars is what made
    // `highlightAuto` cost ~274 ms per call. If this ever climbs back toward
    // that, the fallback has quietly become expensive again.
    expect(HIGHLIGHT_LANGUAGES.length).toBeGreaterThan(10);
    expect(HIGHLIGHT_LANGUAGES.length).toBeLessThan(40);
  });

  it("does not register a language it never lists", () => {
    // `languageFromPath` and the auto-detect subset are both derived from this
    // list, so a grammar reachable outside it would be invisible to both.
    expect(hljs.listLanguages().sort()).toEqual([...HIGHLIGHT_LANGUAGES].sort());
  });

  it("keeps the aliases each grammar brings", () => {
    expect(hljs.getLanguage("html")?.name).toBe("HTML, XML");
    expect(hljs.getLanguage("sh")?.name).toBe("Bash");
    expect(hljs.getLanguage("toml")?.name).toBe("TOML, also INI");
  });
});

describe("the auto-detect subset", () => {
  it("excludes the three grammars that are quadratic on prose", () => {
    // Guessing across these cost a production session an 8.3 s synchronous
    // freeze; they are ~95% of a guess and every other grammar combined is the
    // remaining 5%. See the module doc for the measurements.
    for (const quadratic of ["c", "cpp", "csharp"]) {
      expect(AUTO_DETECT.LANGUAGES).not.toContain(quadratic);
    }
  });

  it("still registers those three, so a fence naming one highlights normally", () => {
    // Only *guessing* changed. A ```c fence is one linear pass and stays colored.
    expect(highlightCode("int main(void) { return 0; }", "c")).toContain("hljs-keyword");
    expect(highlightCode("auto x = std::move(y);", "cpp")).toContain("hljs-");
    expect(highlightCode("public class A { }", "csharp")).toContain("hljs-keyword");
  });

  it("is the registered set minus exactly those three", () => {
    // Both directions matter and neither is visible at the call site. A name
    // guessed at but not registered is silently dropped by `highlightAuto`,
    // shrinking detection with no error anywhere; and a grammar added to the
    // registered set but forgotten here would never be detected. This is what
    // makes either omission a red build rather than a quiet loss.
    const expected = HIGHLIGHT_LANGUAGES.filter((n) => !["c", "cpp", "csharp"].includes(n));
    expect([...AUTO_DETECT.LANGUAGES].sort()).toEqual([...expected].sort());
  });

  it("still detects a real language it does cover", () => {
    // Removing three grammars must not cost detection quality on what is left.
    const ts = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
    expect(hljs.highlightAuto(ts, [...AUTO_DETECT.LANGUAGES]).language).toBe("typescript");
    expect(highlightCode(ts, null)).toContain("hljs-keyword");
  });

  it("colors unlabelled C as something else rather than leaving it plain", () => {
    // The exclusion only stops those three from *winning* detection; the best of
    // the remaining 24 still wins. So unlabelled C is misclassified, not
    // un-highlighted — worth asserting because the opposite is the intuitive
    // reading of "excluded from auto-detect", and the module doc says so.
    const c = "static int handle(struct conn *c, size_t n) {\n  if (!c) return -EINVAL;\n  return 0;\n}\n";
    const html = highlightCode(c, null);
    expect(html).not.toBeNull();
    expect(html).toContain("<span");
    expect(hljs.highlightAuto(c, [...AUTO_DETECT.LANGUAGES]).language).not.toBe("c");
  });
});

describe("the auto-detect size cap", () => {
  it("does not guess at a block larger than the cap", () => {
    const oversized = pathologicalProse(AUTO_DETECT.MAX_CHARS + 1);
    expect(highlightCode(oversized, null)).toBeNull();
  });

  it("still guesses at a block at the cap", () => {
    expect(highlightCode(pathologicalProse(AUTO_DETECT.MAX_CHARS), null)).not.toBeNull();
  });

  it("does not cap a named language", () => {
    // `hljs.highlight` with an explicit grammar is one linear pass — 41 ms on
    // 200 KB — so capping it would strip highlighting from big files to save
    // nothing.
    const big = `const x = 1;\n`.repeat(AUTO_DETECT.MAX_CHARS);
    expect(highlightCode(big, "typescript")).toContain("hljs-keyword");
  });

  it("guesses at prose below the cap without freezing the frame", () => {
    // The real guard: this is the shape that froze a production session for
    // 8.3 s at a larger size.
    //
    // Measured **against a control on the same input**, not against a
    // millisecond budget. An absolute budget was tried first and is genuinely
    // flaky — five isolated runs of this file produced 700 ms and 964 ms
    // against a 500 ms budget alongside three passes, and CI runs test files
    // concurrently on a contended runner. A ratio cannot drift that way,
    // because load slows the control by the same factor it slows the subject.
    //
    // The control is five linear passes over the identical text, so the unit is
    // "what this machine costs to walk this input" and the subject is "how many
    // of those a guess costs". Separation is wide and not marginal: ~8x with
    // the three quadratic grammars excluded, ~73-126x with them included.
    const code = pathologicalProse(AUTO_DETECT.MAX_CHARS - 500);
    highlightCode("warm up the regex compiler", null);

    const controlStarted = performance.now();
    for (let i = 0; i < 5; i++) highlightCode(code, "typescript");
    const control = performance.now() - controlStarted;

    const subjectStarted = performance.now();
    highlightCode(code, null);
    const subject = performance.now() - subjectStarted;

    expect(subject / control).toBeLessThan(25);
  });
});

describe("languageFromPath", () => {
  it.each([
    ["src/client/App.tsx", "typescript"],
    ["/workspace/index.mts", "typescript"],
    ["scripts/build.mjs", "javascript"],
    ["package.json", "json"],
    ["src/index.html", "xml"],
    ["public/logo.svg", "xml"],
    ["styles/app.scss", "scss"],
    ["main.py", "python"],
    ["cmd/server/main.go", "go"],
    ["src/lib.rs", "rust"],
    ["Widget.java", "java"],
    ["App.kt", "kotlin"],
    ["View.swift", "swift"],
    ["Program.cs", "csharp"],
    ["src/util.cpp", "cpp"],
    ["include/util.h", "c"],
    ["deploy.sh", "bash"],
    ["README.md", "markdown"],
    ["docker-compose.yml", "yaml"],
    ["schema.sql", "sql"],
    ["Cargo.toml", "ini"],
    ["fix.patch", "diff"],
    ["notes.txt", "plaintext"],
    ["lib/main.dart", "dart"],
  ])("maps %s to %s", (path, expected) => {
    expect(languageFromPath(path)).toBe(expected);
  });

  it("ignores case in the extension", () => {
    expect(languageFromPath("/workspace/README.MD")).toBe("markdown");
    expect(languageFromPath("Main.PY")).toBe("python");
  });

  it("recognizes extensionless filenames that still name a language", () => {
    expect(languageFromPath("/workspace/Dockerfile")).toBe("dockerfile");
    expect(languageFromPath("/home/shipit/.bashrc")).toBe("bash");
    expect(languageFromPath(".env")).toBe("ini");
  });

  it("recognizes suffixed variants of those filenames", () => {
    expect(languageFromPath(".env.local")).toBe("ini");
    expect(languageFromPath("/workspace/.env.production")).toBe("ini");
    expect(languageFromPath("Dockerfile.prod")).toBe("dockerfile");
  });

  it("prefers a known extension over the filename stem", () => {
    // `Dockerfile.md` is a markdown file about Dockerfiles, not a Dockerfile.
    expect(languageFromPath("Dockerfile.md")).toBe("markdown");
  });

  it("does not read a dotfile's own name as an extension", () => {
    // `.gitignore".split(".").pop()` is "gitignore" — a naive extension split
    // turns every dotfile into a bogus lookup.
    expect(languageFromPath(".gitignore")).toBeNull();
    expect(languageFromPath("/workspace/.prettierrc")).toBeNull();
  });

  it("returns null for an unknown or absent extension", () => {
    expect(languageFromPath("data.parquet")).toBeNull();
    expect(languageFromPath("/usr/bin/somebinary")).toBeNull();
    expect(languageFromPath("")).toBeNull();
  });

  it("reads the extension of the file, not of a directory above it", () => {
    expect(languageFromPath("/workspace/docs.md/index.ts")).toBe("typescript");
  });

  it("handles Windows-style separators", () => {
    expect(languageFromPath("C:\\src\\app.ts")).toBe("typescript");
  });
});

describe("highlightCode", () => {
  it("highlights with the named language", () => {
    const html = highlightCode("const x = 1;", "typescript");
    expect(html).toContain("hljs-keyword");
  });

  it("falls back to auto-detection when no language is given", () => {
    const html = highlightCode("def greet(name):\n    return f'hi {name}'", null);
    expect(html).toContain("hljs-");
  });

  it("returns null for a language outside the subset, rather than guessing", () => {
    // A ```haskell fence. Auto-detecting here would color it as some *other*
    // language and pay the full detection cost to get that wrong — the caller
    // said what this is, and not having the grammar does not overrule them.
    expect(highlightCode('main = putStrLn "hi"', "haskell")).toBeNull();
  });

  it("auto-detects only when there is genuinely no language to go on", () => {
    for (const absent of [null, undefined, ""]) {
      expect(highlightCode("SELECT 1;", absent)).not.toBeNull();
    }
  });

  it("escapes markup so highlighted output cannot inject HTML", () => {
    const html = highlightCode("<script>alert(1)</script>", "javascript");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;");
  });

  it("returns the same markup whether the language is named or detected", () => {
    // The two paths are separate calls into hljs; a divergence here would mean
    // giving the highlighter the language changes what the user sees, not just
    // how long it takes.
    const code = "SELECT id FROM sessions WHERE id = 1;";
    expect(highlightCode(code, "sql")).toBe(highlightCode(code, null));
  });
});
