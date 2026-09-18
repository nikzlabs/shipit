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

  enqueue<T = unknown>(
    action: string,
    opts: { timeoutMs?: number; timeoutMessage?: (action: string, timeoutMs: number) => string } = {},
  ): { requestId: string; promise: Promise<T> } {
    const requestId = `svc-${++this.counter}-${Date.now()}`;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            opts.timeoutMessage?.(action, timeoutMs) ?? `Service ${action} request timed out`,
          ),
        );
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer,
      });
    });
    return { requestId, promise };
  }

  resolve(requestId: string, result: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  }

  reject(requestId: string, error: Error): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.reject(error);
    return true;
  }

  cancel(requestId: string, reason: string): boolean {
    return this.reject(requestId, new Error(reason));
  }

  cancelAll(reason: string): void {
    const err = new Error(reason);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}
