/**
 * PresentRegistry — metadata index for `present` MCP tool artifacts (docs/093).
 *
 * The `present` tool is file-based: the agent writes a file and presents it by
 * path. The registry holds ONLY metadata per artifact — the absolute path to
 * read on demand, plus the display path, MIME, title, and timestamp. It never
 * holds the artifact bytes.
 *
 * Identity is the file path. `presentId` is derived deterministically from
 * (sessionId, resolvedPath) via {@link derivePresentId}, so re-presenting the
 * SAME file yields the SAME id and {@link PresentRegistry.put} overwrites that
 * entry in place (keeping its insertion-order/carousel slot), while a DIFFERENT
 * file yields a different id and appends. This is how the agent shows several
 * artifacts at once (distinct files) yet iterates one in place during the
 * screenshot loop (same file, re-presented) — no explicit "replace" flag, the
 * path is the key. See docs/093, docs/170.
 *
 * Bytes are read from disk lazily, every time an artifact is served:
 *  - the agent's screenshot loop hits `GET /present-files/:presentId` (rendered),
 *  - the user's Present tab fetches `GET /present/:presentId/raw` (raw bytes)
 *    through the orchestrator's authenticated session API.
 *
 * Because nothing large is retained, there are no size, count, or memory caps
 * and no eviction. The container's `/tmp` (or the workspace) is the single
 * source of truth; if the agent overwrites or deletes the file, the next read
 * reflects that (an accepted, rare staleness window — see docs/093). A
 * per-entry `present_cleared` is never emitted; the only clear is a full wipe on
 * session switch.
 */

import { createHash } from "node:crypto";

/**
 * Deterministic `presentId` for a presented file, content-addressed by
 * (sessionId, resolvedPath). Stable across re-presents and container restarts,
 * so the same file always maps to the same carousel entry at every layer
 * (worker registry, orchestrator DB upsert, client store). sessionId is mixed
 * in because `presentId` is globally unique in the orchestrator's store, so two
 * sessions presenting the same path must not collide.
 */
export function derivePresentId(sessionId: string, resolvedPath: string): string {
  const digest = createHash("sha1").update(`${sessionId}\0${resolvedPath}`).digest("hex");
  return `pres_${digest.slice(0, 32)}`;
}

export interface PresentMeta {
  presentId: string;
  /** Absolute path on disk — what the lazy reads open. */
  resolvedPath: string;
  /** The path the agent presented (verbatim), shown in the Present tab header. */
  filePath: string;
  mimeType: string;
  title?: string;
  createdAt: string;
}

export class PresentRegistry {
  /** Insertion-ordered map keyed by presentId. */
  private readonly entries = new Map<string, PresentMeta>();

  /** Current entry count (for diagnostics/tests). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Record a presentation's metadata, keyed by its deterministic `presentId`.
   * Re-presenting the same file (same id) overwrites the entry in place — a
   * `Map.set` on an existing key keeps its insertion position, so the carousel
   * slot is preserved during the screenshot iteration loop. A new file (new id)
   * appends. Returns the stored metadata.
   */
  put(
    presentId: string,
    input: {
      resolvedPath: string;
      filePath: string;
      mimeType: string;
      title?: string;
      createdAt: string;
    },
  ): PresentMeta {
    const meta: PresentMeta = {
      presentId,
      resolvedPath: input.resolvedPath,
      filePath: input.filePath,
      mimeType: input.mimeType,
      ...(input.title !== undefined ? { title: input.title } : {}),
      createdAt: input.createdAt,
    };
    this.entries.set(presentId, meta);
    return meta;
  }

  get(presentId: string): PresentMeta | undefined {
    return this.entries.get(presentId);
  }

  /** Drop a single entry. Returns true if the entry existed. */
  delete(presentId: string): boolean {
    return this.entries.delete(presentId);
  }

  /** Drop every entry. */
  clear(): void {
    this.entries.clear();
  }
}
