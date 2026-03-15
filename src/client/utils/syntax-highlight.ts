import hljs from "highlight.js";

/** Map file extensions to highlight.js language names. */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  sql: "sql",
  xml: "xml",
  toml: "ini",
  dockerfile: "dockerfile",
};

export function languageFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext && EXT_TO_LANG[ext]) return EXT_TO_LANG[ext];
  const name = filePath.split("/").pop()?.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  return undefined;
}

/** Return syntax-highlighted HTML for the given source code. */
export function highlightCode(content: string, filePath: string): string {
  try {
    const lang = languageFromPath(filePath);
    if (lang) return hljs.highlight(content, { language: lang }).value;
    return hljs.highlightAuto(content).value;
  } catch {
    return content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}
