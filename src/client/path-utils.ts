/**
 * Strip the session workspace prefix from absolute file paths.
 *
 * Claude CLI operates inside /workspace/sessions/{uuid}/, so tool call
 * file_path values contain the full absolute path. This utility strips that
 * prefix to show the path relative to the session root.
 *
 * Example: "/workspace/sessions/28e2fa34-.../src/App.tsx" → "src/App.tsx"
 */
const SESSION_PREFIX_RE = /^\/workspace\/sessions\/[^/]+\//;

export function sessionRelativePath(filePath: unknown): string {
  if (typeof filePath !== "string") return "file";
  return filePath.replace(SESSION_PREFIX_RE, "");
}
