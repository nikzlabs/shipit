import fs from "node:fs/promises";
import path from "node:path";

const CLIENT_ASSET_REF_RE = /\b(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g;

/**
 * Returns a stable fingerprint for the client bundle currently served by the
 * orchestrator. Vite emits content-hashed asset filenames into index.html, so
 * the asset refs are the version contract between an already-loaded browser tab
 * and the freshly restarted server.
 */
export async function getServedClientBuildId(clientDir: string): Promise<string | undefined> {
  let html: string;
  try {
    html = await fs.readFile(path.join(clientDir, "index.html"), "utf8");
  } catch {
    return undefined;
  }

  return buildClientAssetFingerprint(html);
}

export function buildClientAssetFingerprint(html: string): string | undefined {
  const refs = [...html.matchAll(CLIENT_ASSET_REF_RE)]
    .map((match) => normalizeAssetRef(match[1]))
    .filter((ref) => ref.length > 0)
    .sort();

  return refs.length > 0 ? refs.join("|") : undefined;
}

function normalizeAssetRef(ref: string): string {
  try {
    const parsed = new URL(ref, "http://shipit.local");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return ref.trim();
  }
}
