import { createHash } from "node:crypto";

// If-None-Match uses weak comparison; CDNs can add W/ when recompressing responses.
function opaqueTag(raw: string): string {
  const trimmed = raw.trim();
  const unweakened = trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
  return unweakened.replace(/^"|"$/g, "");
}

export function etagFor(body: string): string {
  return `"${createHash("sha1").update(body).digest("base64url")}"`;
}

export function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (raw.trim() === "*") return true;
  const want = opaqueTag(etag);
  return raw.split(",").some((candidate) => opaqueTag(candidate) === want);
}
