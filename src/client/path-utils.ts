

const SESSION_PREFIX_RE = /^\/workspace\/(?:sessions\/[^/]+\/)?/;

export function sessionRelativePath(filePath: unknown): string {
  if (typeof filePath !== "string") return "file";
  return filePath.replace(SESSION_PREFIX_RE, "");
}
