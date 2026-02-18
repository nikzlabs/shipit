import fs from "node:fs";
import path from "node:path";

/**
 * A single persisted chat message.
 *
 * This mirrors the client-side `ChatMessage` shape so the client can
 * use the data directly without transformation.
 */
export interface PersistedMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: Array<{
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  images?: Array<{
    data: string;
    mediaType: string;
  }>;
  files?: Array<{
    path: string;
    contentPreview: string;
    startLine?: number;
    endLine?: number;
  }>;
  isError?: boolean;
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
        return JSON.parse(raw);
      }
    } catch {
      // Corrupted file — return empty
    }
    return [];
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
      console.error("[chat-history] failed to save:", err instanceof Error ? err.message : String(err));
    }
  }
}
