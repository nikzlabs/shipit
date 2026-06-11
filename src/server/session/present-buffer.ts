/**
 * PresentBuffer — in-memory snapshot store for `present` MCP tool artifacts
 * (docs/093).
 *
 * Each present entry is `{ content, mimeType, title, createdAt }`, captured as
 * a point-in-time snapshot of the file's bytes at present-time. The buffer is
 * intentionally NOT capped by artifact size or entry count — those limits made
 * the UX worse (a 1 MB artifact was rejected outright; the 21st presentation
 * silently evicted the oldest, stranding its chat-card "View" button). A
 * presentation should just show, and stay showable.
 *
 * The only remaining bound is a single, generous **total-memory backstop**
 * (default 256 MB). It exists for one reason: the buffer lives in the worker's
 * RAM, and an unbounded buffer could OOM the container and take the whole
 * session down — a strictly worse failure than dropping the oldest artifact.
 * It is large enough that real sessions never reach it; when they somehow do,
 * the oldest entries are LRU-evicted (best-effort) and a `present_cleared` SSE
 * event is surfaced so the client drops them too. The newest entry is never
 * evicted, even if it alone exceeds the budget.
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
  /**
   * Total-memory backstop in bytes (default 256 MB). Purely an OOM guard — set
   * generously so it never bites real usage. When exceeded, oldest entries are
   * LRU-evicted (best-effort) until the buffer is back under budget or only the
   * newest entry remains.
   */
  maxTotalBytes?: number;
}

const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 256 MB

export class PresentBuffer {
  private readonly maxTotalBytes: number;

  /**
   * Insertion-ordered map keyed by presentId. Map preserves insertion order,
   * which gives us LRU (oldest entry is the iterator's first key).
   */
  private readonly entries = new Map<string, PresentEntry>();
  private totalBytes = 0;

  constructor(opts: PresentBufferOptions = {}) {
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
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
   * broadcast `present_cleared` events for (LRU evictions from the memory
   * backstop that freed room for the new entry — normally empty).
   *
   * If `replaceId` is provided and the entry exists, replaces it in-place
   * without changing list ordering — the revision flow. The returned eviction
   * list carries only the replaced id (when it differs from the new one).
   *
   * Never rejects: there is no per-artifact size limit. An artifact larger than
   * the whole backstop is kept anyway (it just becomes the only entry).
   */
  put(
    presentId: string,
    input: { content: string; mimeType: string; title?: string; replaceId?: string },
  ): { entry: PresentEntry; evicted: string[] } {
    const byteSize = Buffer.byteLength(input.content, "utf8");

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

    // Memory backstop only — evict oldest until under budget, but never drop
    // the entry we just added (so a single oversized artifact still shows).
    const evicted: string[] = [];
    while (this.totalBytes > this.maxTotalBytes && this.entries.size > 1) {
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
