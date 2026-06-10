/**
 * PresentBuffer — in-memory store for `present` MCP tool artifacts (docs/093).
 *
 * Each present entry is `{ content, mimeType, title, createdAt }`. The buffer
 * is bounded two ways:
 *
 *  - **Per-presentation byte cap** (default 1 MB). Larger artifacts are
 *    rejected with a clear error to the agent — the WS/SSE pipeline that
 *    carries the content downstream is not designed for many-MB payloads.
 *  - **Total byte ceiling** (default 16 MB) and **entry cap** (default 20).
 *    LRU-evict oldest until both invariants hold. Eviction surfaces a
 *    `present_cleared` SSE event so the client drops just that entry.
 *
 * The buffer never persists to disk — the container's `/tmp` lifetime is the
 * hard upper bound on entry lifetime. "Save to project" reads from this
 * buffer; once the agent container is gone, so is the option to save.
 */

export interface PresentEntry {
  content: string;
  mimeType: string;
  title?: string;
  createdAt: string;
  /** Cached byte length so eviction doesn't re-measure. */
  byteSize: number;
}

export interface PresentBufferOptions {
  /** Maximum bytes per individual presentation (default 1 MB). */
  maxBytesPerEntry?: number;
  /** Maximum total bytes across all live entries (default 16 MB). */
  maxTotalBytes?: number;
  /** Maximum simultaneous live entries (default 20). */
  maxEntries?: number;
}

const DEFAULT_MAX_BYTES_PER_ENTRY = 1 * 1024 * 1024; // 1 MB
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024; // 16 MB
const DEFAULT_MAX_ENTRIES = 20;

export class PresentBufferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresentBufferError";
  }
}

export class PresentBuffer {
  private readonly maxBytesPerEntry: number;
  private readonly maxTotalBytes: number;
  private readonly maxEntries: number;

  /**
   * Insertion-ordered map keyed by presentId. Map preserves insertion order,
   * which gives us LRU (oldest entry is the iterator's first key).
   */
  private readonly entries = new Map<string, PresentEntry>();
  private totalBytes = 0;

  constructor(opts: PresentBufferOptions = {}) {
    this.maxBytesPerEntry = opts.maxBytesPerEntry ?? DEFAULT_MAX_BYTES_PER_ENTRY;
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Current entry count (for diagnostics/tests). */
  get size(): number {
    return this.entries.size;
  }

  /** Current total byte usage (for diagnostics/tests). */
  get bytes(): number {
    return this.totalBytes;
  }

  /**
   * Store a new presentation. Returns the list of presentIds the caller must
   * broadcast `present_cleared` events for (LRU evictions that freed room
   * for the new entry).
   *
   * If `replaceId` is provided and the entry exists, replaces it in-place
   * without changing list ordering — the revision flow. The returned eviction
   * list is empty in that case.
   *
   * Throws {@link PresentBufferError} when the single entry exceeds
   * `maxBytesPerEntry` (the WS message will not carry it cleanly).
   */
  put(
    presentId: string,
    input: { content: string; mimeType: string; title?: string; replaceId?: string },
  ): { entry: PresentEntry; evicted: string[] } {
    const byteSize = Buffer.byteLength(input.content, "utf8");
    if (byteSize > this.maxBytesPerEntry) {
      const mb = (this.maxBytesPerEntry / (1024 * 1024)).toFixed(0);
      throw new PresentBufferError(
        `Content is too large for inline presentation (${byteSize} bytes; limit ${mb} MB). ` +
          "Simplify the artifact, drop embedded base64 assets, or split it into separate presentations.",
      );
    }

    const entry: PresentEntry = {
      content: input.content,
      mimeType: input.mimeType,
      ...(input.title !== undefined ? { title: input.title } : {}),
      createdAt: new Date().toISOString(),
      byteSize,
    };

    // Revision flow — replace in-place without re-ordering or evictions.
    if (input.replaceId && this.entries.has(input.replaceId)) {
      const prev = this.entries.get(input.replaceId)!;
      this.totalBytes -= prev.byteSize;
      this.entries.delete(input.replaceId);
      this.entries.set(presentId, entry);
      this.totalBytes += byteSize;
      // The replaced id is gone; the new id may differ. Tell the caller so it
      // can broadcast a clear for the old id when it doesn't match the new one.
      const evicted = input.replaceId !== presentId ? [input.replaceId] : [];
      return { entry, evicted };
    }

    this.entries.set(presentId, entry);
    this.totalBytes += byteSize;

    const evicted: string[] = [];
    while (
      this.entries.size > this.maxEntries
      || this.totalBytes > this.maxTotalBytes
    ) {
      const oldestId = this.entries.keys().next().value;
      if (!oldestId || oldestId === presentId) break;
      const oldest = this.entries.get(oldestId)!;
      this.totalBytes -= oldest.byteSize;
      this.entries.delete(oldestId);
      evicted.push(oldestId);
    }

    return { entry, evicted };
  }

  get(presentId: string): PresentEntry | undefined {
    return this.entries.get(presentId);
  }

  /** Drop a single entry. Returns true if the entry existed. */
  delete(presentId: string): boolean {
    const entry = this.entries.get(presentId);
    if (!entry) return false;
    this.totalBytes -= entry.byteSize;
    this.entries.delete(presentId);
    return true;
  }

  /** Drop every entry. */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}
