import fs from "node:fs";
import path from "node:path";

export const PLUGIN_GENERATION_RECORD_FILE = ".shipit-generation.json";

/** null means ownership is unknown; callers must not expose that generation. */
export function readPluginGenerationSource(generationDir: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(generationDir, PLUGIN_GENERATION_RECORD_FILE), "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const source = (parsed as Record<string, unknown>).source;
  return typeof source === "string" ? source : null;
}
