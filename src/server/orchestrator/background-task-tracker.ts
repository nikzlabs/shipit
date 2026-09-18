// Bash tasks send no heartbeat. Bound stale lists without expiring ordinary long tasks.
export const BACKGROUND_TASK_TTL_MS = 3_600_000;

export interface BackgroundTaskInfo {
  id: string;
  type?: string;
  description?: string;
}

export class BackgroundTaskTracker {
  private tasks: BackgroundTaskInfo[] = [];
  private seenAt = 0;

  set(tasks: BackgroundTaskInfo[]): void {
    this.tasks = tasks;
    this.seenAt = tasks.length > 0 ? Date.now() : 0;
  }

  clear(): void {
    this.tasks = [];
    this.seenAt = 0;
  }

  count(streamingActive: boolean, now: number = Date.now()): number {
    if (!streamingActive) return 0;
    if (this.tasks.length === 0) return 0;
    if (now - this.seenAt >= BACKGROUND_TASK_TTL_MS) return 0;
    return this.tasks.length;
  }

  descriptions(streamingActive: boolean, now: number = Date.now()): string[] {
    if (this.count(streamingActive, now) === 0) return [];
    return this.tasks.map((t) => t.description ?? t.id);
  }
}
