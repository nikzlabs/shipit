/**
 * PresentRegistry — metadata index for `present` MCP tool artifacts (docs/093).
 *
 * The `present` tool is file-based: the agent writes a file and presents it by
 * path. The registry holds ONLY metadata per artifact — the absolute path to
 * read on demand, plus the display path, MIME, title, and timestamp. It never
 * holds the artifact bytes.
 *
 * Bytes are read from disk lazily, every time an artifact is served:
 *  - the agent's screenshot loop hits `GET /present-files/:presentId` (rendered),
 *  - the user's Present tab fetches `GET /present/:presentId/raw` (raw bytes)
 *    through the orchestrator's authenticated session API.
 *
 * Because nothing large is retained, there are no size, count, or memory caps
 * and no eviction. The container's `/tmp` (or the workspace) is the single
 * source of truth; if the agent overwrites or deletes the file, the next read
 * reflects that (an accepted, rare staleness window — see docs/093). The only
 * `present_cleared` paths are a revision superseding an id and a full clear on
 * session switch.
 */

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
   * Record (or revise) a presentation's metadata. Returns the ids the caller
   * must broadcast `present_cleared` for — only the superseded id in the
   * revision flow (when `replaceId` differs from the new id); otherwise empty.
   */
  put(
    presentId: string,
    input: {
      resolvedPath: string;
      filePath: string;
      mimeType: string;
      title?: string;
      createdAt: string;
      replaceId?: string;
    },
  ): { meta: PresentMeta; evicted: string[] } {
    const meta: PresentMeta = {
      presentId,
      resolvedPath: input.resolvedPath,
      filePath: input.filePath,
      mimeType: input.mimeType,
      ...(input.title !== undefined ? { title: input.title } : {}),
      createdAt: input.createdAt,
    };

    // Revision flow — drop the superseded id, insert the new one.
    if (input.replaceId && this.entries.has(input.replaceId)) {
      this.entries.delete(input.replaceId);
      this.entries.set(presentId, meta);
      const evicted = input.replaceId !== presentId ? [input.replaceId] : [];
      return { meta, evicted };
    }

    this.entries.set(presentId, meta);
    return { meta, evicted: [] };
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
