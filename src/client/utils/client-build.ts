const CLIENT_ASSET_SELECTOR = 'script[src*="/assets/"],link[href*="/assets/"]';

export function getLoadedClientBuildId(doc: Document = document): string | undefined {
  const refs = Array.from(doc.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(CLIENT_ASSET_SELECTOR))
    .map((el) => "src" in el ? el.src : el.href)
    .map(normalizeAssetRef)
    .filter((ref) => ref.length > 0)
    .sort();

  return refs.length > 0 ? refs.join("|") : undefined;
}

export function shouldReloadForServerBuild(
  loadedClientBuildId: string | undefined,
  servedClientBuildId: string | undefined,
): boolean {
  return Boolean(loadedClientBuildId && servedClientBuildId && loadedClientBuildId !== servedClientBuildId);
}

function normalizeAssetRef(ref: string): string {
  try {
    const parsed = new URL(ref, window.location.href);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return ref.trim();
  }
}
