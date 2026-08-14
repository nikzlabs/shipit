/**
 * docs/262 — the one fact the session container needs out of a published
 * generation: which repository it came from.
 *
 * The orchestrator writes a record into each generation directory when it
 * publishes; the container reads this field out of the read-only plugin store
 * to decide whether the generation it can see is the one its declaration names
 * (req 19 — the standing grant is per NAMED repository, so a generation whose
 * recorded source does not match is not covered by it).
 *
 * It lives in `shared/` because `src/server/session/` cannot import
 * `src/server/orchestrator/` — the ESLint boundary forbids it, type imports
 * included — and a container-side copy would be a second implementation of a
 * format only one file writes. The orchestrator keeps its own richer reader in
 * `plugin-generations.ts`; folding that one into this is a follow-up for
 * whoever next owns that file.
 *
 * **Only `source` is exposed, deliberately.** The container has no use for the
 * commit or the ref, and a reader that also returned them would invite the
 * question of what to do with a record whose *other* fields are malformed —
 * a question with no bearing on the only decision made here. This is also a
 * format read across a version boundary (a container outlives an orchestrator
 * restart), so an unknown or extra field is data to ignore, never a parse
 * failure.
 */

import fs from "node:fs";
import path from "node:path";

/** Written into every published generation directory. */
export const PLUGIN_GENERATION_RECORD_FILE = ".shipit-generation.json";

/**
 * Which repository the generation in `generationDir` came from — `owner/repo`
 * lowercased, or `self`, matching `destinationKey(repo.source)`. `null` when
 * that cannot be established.
 *
 * **`null` covers two different situations and callers must treat them the
 * same way.** There may be no record at all (nothing published, a directory
 * mid-prune), or a record written before ShipIt recorded the field. In neither
 * case can anything prove whose generation it is, so neither may be exposed —
 * the orchestrator keeps a source-less generation rather than deleting it
 * precisely because this refusal is what makes keeping it safe.
 *
 * Fails closed on anything unexpected: not JSON, not an object, an array, or a
 * `source` that is not a string all read as `null`. A corrupt file must not be
 * able to decide that a foreign checkout belongs to this declaration.
 */
export function readPluginGenerationSource(generationDir: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(generationDir, PLUGIN_GENERATION_RECORD_FILE), "utf-8"));
  } catch {
    return null;
  }
  // `typeof [] === "object"` too, and an array is not a record.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const source = (parsed as Record<string, unknown>).source;
  return typeof source === "string" ? source : null;
}
