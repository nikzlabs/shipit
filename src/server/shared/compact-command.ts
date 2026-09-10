export function parseCompactCommand(text: string): { match: boolean; instructions?: string } {
  const m = /^\/compact(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!m) return { match: false };
  const instructions = m[1]?.trim();
  return instructions ? { match: true, instructions } : { match: true };
}

export function isCompactCommand(text: string): boolean {
  return parseCompactCommand(text).match;
}
