/**
 * ServiceRequestQueue — bridges the worker's "ask the orchestrator to do
 * something" HTTP endpoints to the SSE-driven request/callback protocol.
 *
 * The worker emits a `service_request` SSE event with a generated `requestId`
 * and stashes a pending entry in this queue. The orchestrator handles the
 * request (e.g. via ServiceManager) and POSTs the result back to the worker's
 * `/services/_callback`, which resolves the matching entry.
 *
 * Entries time out after SERVICE_REQUEST_TIMEOUT_MS so a missing callback
 * doesn't strand the awaiting promise. On worker shutdown, callers can drain
 * pending entries via `cancelAll()`.
 *
 * This class owns no I/O: it produces request IDs and resolves/rejects
 * promises. The worker is responsible for emitting the SSE event and calling
 * the queue methods at the right moments.
 */

/** A pending service request awaiting an orchestrator callback. */
export interface PendingServiceRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ServiceRequestQueue {
  private static readonly DEFAULT_TIMEOUT_MS = 60_000;

  private readonly pending = new Map<string, PendingServiceRequest>();
  private counter = 0;
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = ServiceRequestQueue.DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Enqueue a new request and return a promise that resolves when the
   * orchestrator calls back with the result. The returned `requestId`
   * should be embedded in the corresponding `service_request` SSE event.
   */
  enqueue<T = unknown>(action: string): { requestId: string; promise: Promise<T> } {
    const requestId = `svc-${++this.counter}-${Date.now()}`;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Service ${action} request timed out`));
      }, this.timeoutMs);

      this.pending.set(requestId, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer,
      });
    });
    return { requestId, promise };
  }

  /**
   * Resolve a pending request with a result. Returns `true` if the request
   * was found and resolved, `false` if the id is unknown or expired.
   */
  resolve(requestId: string, result: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  }

  /**
   * Reject a pending request with an error. Returns `true` if the request
   * was found and rejected, `false` if the id is unknown or expired.
   */
  reject(requestId: string, error: Error): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.reject(error);
    return true;
  }

  /**
   * Cancel a single pending request with a rejection. Returns `true` if it
   * was found and cancelled.
   */
  cancel(requestId: string, reason: string): boolean {
    return this.reject(requestId, new Error(reason));
  }

  /**
   * Cancel every pending request with the given rejection reason. Used on
   * worker shutdown so awaiting promises don't hang forever.
   */
  cancelAll(reason: string): void {
    const err = new Error(reason);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}
