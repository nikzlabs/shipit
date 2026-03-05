import fs from "node:fs";
import path from "node:path";
import { getErrorMessage } from "../shared/utils.js";

/**
 * A single persisted chat message.
 *
 * This mirrors the client-side `ChatMessage` shape so the client can
 * use the data directly without transformation.
 */
export interface PersistedMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }[];
  images?: {
    data: string;
    mediaType: string;
  }[];
  files?: {
    path: string;
    contentPreview: string;
    startLine?: number;
    endLine?: number;
  }[];
  isError?: boolean;
  toolResults?: {
    toolUseId: string;
    content: string;
    isError?: boolean;
  }[];
  /** True while the agent turn that produced this message is still running. */
  inProgress?: boolean;
  /** Git commit hash produced by auto-commit after this assistant message. */
  commitHash?: string;
  /** Parent commit hash (HEAD before the auto-commit). Used for rollback. */
  parentCommitHash?: string;
}

const DEFAULT_HISTORY_DIR = path.join("/workspace", ".vibe-chat-history");

/**
 * Persists chat messages per session to disk as JSON files.
 *
 * Storage layout:
 *   {historyDir}/{sessionId}.json — array of PersistedMessage
 *
 * @param historyDir - Directory for history files.
 *   Defaults to `/workspace/.vibe-chat-history`. Override in tests.
 */
export class ChatHistoryManager {
  private historyDir: string;

  constructor(historyDir?: string) {
    this.historyDir = historyDir ?? DEFAULT_HISTORY_DIR;
    this.ensureDir();
  }

  private ensureDir(): void {
    try {
      if (!fs.existsSync(this.historyDir)) {
        fs.mkdirSync(this.historyDir, { recursive: true });
      }
    } catch {
      // Best-effort — if we can't create it, reads will return []
    }
  }

  private filePath(sessionId: string): string {
    // Sanitize sessionId to prevent path traversal
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.historyDir, `${safe}.json`);
  }

  /** Append a message to a session's history. */
  append(sessionId: string, message: PersistedMessage): void {
    const messages = this.load(sessionId);
    messages.push(message);
    this.save(sessionId, messages);
  }

  /** Load all messages for a session. Returns [] if none exist. */
  load(sessionId: string): PersistedMessage[] {
    try {
      const fp = this.filePath(sessionId);
      if (fs.existsSync(fp)) {
        const raw = fs.readFileSync(fp, "utf-8");
        return JSON.parse(raw) as PersistedMessage[];
      }
    } catch {
      // Corrupted file — return empty
    }
    return [];
  }

  /** Update the last message in a session's history by merging fields. */
  updateLastMessage(sessionId: string, update: Partial<PersistedMessage>): void {
    const messages = this.load(sessionId);
    if (messages.length === 0) return;
    Object.assign(messages[messages.length - 1], update);
    this.save(sessionId, messages);
  }

  /** Truncate a session's history to the first `count` messages. */
  truncate(sessionId: string, count: number): PersistedMessage[] {
    const messages = this.load(sessionId);
    const truncated = messages.slice(0, count);
    this.save(sessionId, truncated);
    return truncated;
  }

  /** Save messages for a session (overwriting existing history). */
  saveMessages(sessionId: string, messages: PersistedMessage[]): void {
    this.save(sessionId, messages);
  }

  /**
   * Replace all in-progress messages for a session with the given set.
   * Called at each agent_tool_result boundary with the accumulated message groups.
   */
  replaceInProgress(sessionId: string, messages: PersistedMessage[]): void {
    const existing = this.load(sessionId);
    const kept = existing.filter((m) => !m.inProgress);
    this.save(sessionId, [...kept, ...messages]);
  }

  /** Remove the inProgress flag from all messages. Called on agent_result. */
  finalizeInProgress(sessionId: string): void {
    const messages = this.load(sessionId);
    let changed = false;
    for (const m of messages) {
      if (m.inProgress) {
        delete m.inProgress;
        changed = true;
      }
    }
    if (changed) this.save(sessionId, messages);
  }

  /** Remove all in-progress messages. Called on agent error/abort. */
  clearInProgress(sessionId: string): void {
    const messages = this.load(sessionId);
    const kept = messages.filter((m) => !m.inProgress);
    if (kept.length !== messages.length) {
      this.save(sessionId, kept);
    }
  }

  /** Delete a session's chat history. */
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

  /** List session IDs that have stored history. */
  listSessions(): string[] {
    try {
      return fs
        .readdirSync(this.historyDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }

  private save(sessionId: string, messages: PersistedMessage[]): void {
    try {
      this.ensureDir();
      fs.writeFileSync(this.filePath(sessionId), JSON.stringify(messages, null, 2));
    } catch (err) {
      console.error("[chat-history] failed to save:", getErrorMessage(err));
    }
  }
}
