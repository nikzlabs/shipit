import { describe, it, expect } from "vitest";
import { hljs, HIGHLIGHT_LANGUAGES, highlightCode, languageFromPath } from "./syntax-highlight.js";

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
