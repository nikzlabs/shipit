import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * A checkpoint is a snapshot of conversation + git state at a specific point.
 * Users can fork a new thread from checkpoints to explore alternative approaches.
 */
export interface Checkpoint {
  id: string;
  /** The app session ID that owns this checkpoint. */
  sessionId: string;
  /** Index in the conversation message array at the time of checkpoint. */
  messageIndex: number;
  /** Git commit hash at the time of checkpoint. */
  commitHash: string;
  /** Timestamp of creation. */
  createdAt: string;
  /** Optional human-readable label. */
  label?: string;
}

/**
 * A thread represents a divergent conversation path from a checkpoint.
 * Each thread has its own conversation history and Claude CLI session.
 */
export interface Thread {
  id: string;
  /** The app session ID this thread belongs to. */
  sessionId: string;
  /** The checkpoint this thread was forked from (null for the initial "main" thread). */
  parentCheckpointId: string | null;
  /** Claude CLI agent session ID for this thread (set when the first message is sent). */
  agentSessionId?: string;
  /** Display name. */
  name: string;
  /** Checkpoints within this thread. */
  checkpoints: Checkpoint[];
  /** Whether this thread is the currently active one. */
  isActive: boolean;
  /** Timestamp of creation. */
  createdAt: string;
  /**
   * Conversation replay text to inject as a system prompt when starting the
   * first Claude session on a forked thread. Cleared after use.
   */
  conversationReplay?: string;
}

/**
 * Persisted data for a single app session's threads.
 */
interface ThreadData {
  threads: Thread[];
  activeThreadId: string;
}

const DEFAULT_THREADS_DIR = path.join("/workspace", ".vibe-threads");

/**
 * Manages conversation threads and checkpoints.
 *
 * Each app session can have multiple threads, each with their own
 * checkpoints. Data is persisted to JSON files in the threads directory.
 *
 * @param threadsDir - Directory for thread data files.
 *   Defaults to `/workspace/.vibe-threads`. Override in tests.
 */
export class ThreadManager {
  private threadsDir: string;

  constructor(threadsDir?: string) {
    this.threadsDir = threadsDir ?? DEFAULT_THREADS_DIR;
    this.ensureDir();
  }

  private ensureDir(): void {
    try {
      if (!fs.existsSync(this.threadsDir)) {
        fs.mkdirSync(this.threadsDir, { recursive: true });
      }
    } catch {
      // Best-effort
    }
  }

  private filePath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.threadsDir, `${safe}.json`);
  }

  private load(sessionId: string): ThreadData | null {
    try {
      const fp = this.filePath(sessionId);
      if (fs.existsSync(fp)) {
        const raw = fs.readFileSync(fp, "utf-8");
        return JSON.parse(raw);
      }
    } catch {
      // Corrupted file — return null
    }
    return null;
  }

  /** Load data for a session, creating default data if needed. */
  private loadOrCreate(sessionId: string): ThreadData {
    const data = this.load(sessionId);
    if (data) return data;
    const defaults = this.defaultData(sessionId);
    this.save(sessionId, defaults);
    return defaults;
  }

  private save(sessionId: string, data: ThreadData): void {
    try {
      this.ensureDir();
      fs.writeFileSync(this.filePath(sessionId), JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[threads] failed to save:", err instanceof Error ? err.message : String(err));
    }
  }

  /** Create the default thread data with a single "main" thread. */
  private defaultData(sessionId: string): ThreadData {
    const mainThread: Thread = {
      id: crypto.randomUUID(),
      sessionId,
      parentCheckpointId: null,
      name: "main",
      checkpoints: [],
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    return { threads: [mainThread], activeThreadId: mainThread.id };
  }

  /**
   * Initialize thread data for a session if it doesn't exist.
   * Returns the initial thread data.
   */
  init(sessionId: string): ThreadData {
    return this.loadOrCreate(sessionId);
  }

  /** List all threads for a session. */
  listThreads(sessionId: string): { threads: Thread[]; activeThreadId: string } {
    const data = this.loadOrCreate(sessionId);
    return { threads: data.threads, activeThreadId: data.activeThreadId };
  }

  /** Get the active thread for a session. */
  getActiveThread(sessionId: string): Thread | undefined {
    const data = this.loadOrCreate(sessionId);
    return data.threads.find((t) => t.id === data.activeThreadId);
  }

  /**
   * Create a checkpoint on the active thread.
   *
   * @param sessionId - App session ID.
   * @param messageIndex - The conversation message index at checkpoint time.
   * @param commitHash - The git commit hash at checkpoint time.
   * @param label - Optional human-readable label.
   * @returns The created checkpoint, or null if no active thread exists.
   */
  createCheckpoint(
    sessionId: string,
    messageIndex: number,
    commitHash: string,
    label?: string,
  ): Checkpoint | null {
    const data = this.loadOrCreate(sessionId);
    const thread = data.threads.find((t) => t.id === data.activeThreadId);
    if (!thread) return null;

    const checkpoint: Checkpoint = {
      id: crypto.randomUUID(),
      sessionId,
      messageIndex,
      commitHash,
      createdAt: new Date().toISOString(),
      label,
    };

    thread.checkpoints.push(checkpoint);
    this.save(sessionId, data);
    return checkpoint;
  }

  /**
   * Get a checkpoint by ID across all threads in a session.
   */
  getCheckpoint(sessionId: string, checkpointId: string): Checkpoint | undefined {
    const data = this.loadOrCreate(sessionId);
    for (const thread of data.threads) {
      const cp = thread.checkpoints.find((c) => c.id === checkpointId);
      if (cp) return cp;
    }
    return undefined;
  }

  /**
   * Fork a new thread from a checkpoint. The new thread becomes active.
   *
   * @param sessionId - App session ID.
   * @param checkpointId - The checkpoint to fork from.
   * @returns The new thread, or null if the checkpoint wasn't found.
   */
  forkThread(sessionId: string, checkpointId: string): Thread | null {
    const data = this.loadOrCreate(sessionId);

    // Find the checkpoint
    let checkpoint: Checkpoint | undefined;
    for (const t of data.threads) {
      checkpoint = t.checkpoints.find((c) => c.id === checkpointId);
      if (checkpoint) break;
    }
    if (!checkpoint) return null;

    // Count existing threads for naming
    const threadNumber = data.threads.length;

    const newThread: Thread = {
      id: crypto.randomUUID(),
      sessionId,
      parentCheckpointId: checkpointId,
      name: `Thread ${threadNumber}`,
      checkpoints: [],
      isActive: true,
      createdAt: new Date().toISOString(),
    };

    // Deactivate all other threads
    for (const t of data.threads) {
      t.isActive = false;
    }

    data.threads.push(newThread);
    data.activeThreadId = newThread.id;
    this.save(sessionId, data);
    return newThread;
  }

  /**
   * Restore thread data from a snapshot. Used to re-persist data after a git
   * rollback that may have reverted the thread JSON file on disk.
   */
  restore(sessionId: string, snapshot: { threads: Thread[]; activeThreadId: string }): void {
    this.save(sessionId, snapshot);
  }

  /**
   * Switch to an existing thread. Returns the thread, or null if not found.
   */
  switchThread(sessionId: string, threadId: string): Thread | null {
    const data = this.loadOrCreate(sessionId);
    const thread = data.threads.find((t) => t.id === threadId);
    if (!thread) return null;

    // Deactivate all, activate the target
    for (const t of data.threads) {
      t.isActive = t.id === threadId;
    }
    data.activeThreadId = threadId;
    this.save(sessionId, data);
    return thread;
  }

  /**
   * Set the agent session ID on a thread (called when the CLI reports its session ID).
   */
  setAgentSessionId(sessionId: string, threadId: string, agentSessionId: string): void {
    const data = this.loadOrCreate(sessionId);
    const thread = data.threads.find((t) => t.id === threadId);
    if (thread) {
      thread.agentSessionId = agentSessionId;
      this.save(sessionId, data);
    }
  }

  /**
   * Set conversation replay text on a thread. This is the conversation context
   * that will be injected as a system prompt when the first message is sent on
   * a forked thread.
   */
  setConversationReplay(sessionId: string, threadId: string, replay: string): void {
    const data = this.loadOrCreate(sessionId);
    const thread = data.threads.find((t) => t.id === threadId);
    if (thread) {
      thread.conversationReplay = replay;
      this.save(sessionId, data);
    }
  }

  /**
   * Consume the conversation replay for a thread. Returns the replay text
   * and clears it so it's only used once (for the first message on a fork).
   */
  consumeConversationReplay(sessionId: string, threadId: string): string | undefined {
    const data = this.loadOrCreate(sessionId);
    const thread = data.threads.find((t) => t.id === threadId);
    if (!thread?.conversationReplay) return undefined;
    const replay = thread.conversationReplay;
    thread.conversationReplay = undefined;
    this.save(sessionId, data);
    return replay;
  }

  /**
   * Delete all thread data for a session.
   */
  delete(sessionId: string): boolean {
    try {
      const fp = this.filePath(sessionId);
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        return true;
      }
    } catch {
      // Best-effort
    }
    return false;
  }
}
