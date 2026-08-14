/**
 * docs/262 — the generation record, as an on-disk contract between the two
 * halves of ShipIt rather than a type one half owns.
 *
 * The orchestrator writes this file into a generation directory when it
 * publishes; the session container reads it out of the read-only plugin store
 * to decide whether the generation it can see is the one its declaration names
 * (req 19 — the standing grant is per NAMED repository, so a generation whose
 * recorded source does not match is not covered by it).
 *
 * It lives in `shared/` because `src/server/session/` cannot import
 * `src/server/orchestrator/` — the ESLint boundary forbids it, type imports
 * included — and a container-side copy of the reader would be the second
 * implementation of a format only one file writes. The orchestrator still has
 * its own reader in `plugin-generations.ts`; folding it into this one is a
 * follow-up that belongs with whoever next touches that file, not a drive-by
 * from the container side.
 *
 * Only the fields the container actually uses are declared. This is a format
 * read across a version boundary — a container outlives an orchestrator
 * restart and a rolling upgrade puts a new orchestrator in front of an old
 * worker — so an unknown field is data to ignore, never a parse failure.
 */

import fs from "node:fs";
import path from "node:path";

/** Written into every published generation directory. */
export const PLUGIN_GENERATION_RECORD_FILE = ".shipit-generation.json";

export interface PluginGenerationRecord {
  /** The declaration name this generation was published under. */
  repoName: string;
  commit: string;
  ref: string;
  /**
   * Which repository the generation actually came from — `owner/repo`
   * lowercased, or `self`. Matches `destinationKey(repo.source)`.
   *
   * **Optional on purpose, and absence is not the same as a mismatch.** A
   * generation published before the field existed carries none, and nothing
   * can prove whose it is. The orchestrator deliberately keeps such a
   * generation rather than deleting it — deleting would drop every plugin in
   * every live session on the first deploy, before a fetch that may fail. It
   * is the container's refusal to EXPOSE it that makes keeping it safe, so
   * readers here must treat "no source" as "not this declaration's" rather
   * than as "probably fine".
   */
  source?: string;
}

/**
 * The record in `generationDir`, or `null` when there is none to read.
 *
 * Fail closed on anything unexpected: a record that is not an object, or whose
 * `source` is not a string, reads as a record with no source — which every
 * caller treats as "nothing live". The alternative, trusting a malformed field,
 * would let a corrupt file decide that a foreign checkout is this
 * declaration's.
 */
export function readPluginGenerationRecord(generationDir: string): PluginGenerationRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(generationDir, PLUGIN_GENERATION_RECORD_FILE), "utf-8"));
  } catch {
    return null;
  }
  // `typeof [] === "object"` too, and an array is not a record — without the
  // array check it would parse into one whose every field is empty.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return {
    repoName: typeof record.repoName === "string" ? record.repoName : "",
    commit: typeof record.commit === "string" ? record.commit : "",
    ref: typeof record.ref === "string" ? record.ref : "",
    ...(typeof record.source === "string" ? { source: record.source } : {}),
  };
}
