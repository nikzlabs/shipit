import fs from "node:fs";
import path from "node:path";
import type { SessionInfo } from "./types.js";

const DEFAULT_SESSIONS_FILE = path.join("/workspace", ".vibe-sessions.json");

/**
 * Manages session persistence. Stores session metadata in a JSON file
 * so users can list, resume, and start new sessions.
 *
 * @param sessionsFile - Path to the JSON file for persistence.
 *   Defaults to `/workspace/.vibe-sessions.json`. Override in tests.
 */
export class SessionManager {
  private sessions: SessionInfo[] = [];
  private sessionsFile: string;

  constructor(sessionsFile?: string) {
    this.sessionsFile = sessionsFile ?? DEFAULT_SESSIONS_FILE;
    this.load();
  }

  /** Load sessions from disk. */
  private load(): void {
    try {
      if (fs.existsSync(this.sessionsFile)) {
        const raw = fs.readFileSync(this.sessionsFile, "utf-8");
        this.sessions = JSON.parse(raw);
      }
    } catch {
      this.sessions = [];
    }
  }

  /** Persist sessions to disk. */
  private save(): void {
    try {
      fs.writeFileSync(this.sessionsFile, JSON.stringify(this.sessions, null, 2));
    } catch (err) {
      console.error("[sessions] failed to save:", err instanceof Error ? err.message : String(err));
    }
  }

  /** List all non-archived sessions, most recently used first. */
  list(): SessionInfo[] {
    return this.sessions
      .filter((s) => s.archived !== true)
      .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
  }

  /** Get a session by id. Returns undefined if not found. */
  get(id: string): SessionInfo | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** Track a session — creates it if new, updates lastUsedAt if existing. */
  track(id: string, title?: string, workspaceDir?: string): SessionInfo {
    const now = new Date().toISOString();
    const existing = this.sessions.find((s) => s.id === id);
    if (existing) {
      existing.lastUsedAt = now;
      if (title) existing.title = title;
      if (workspaceDir && !existing.workspaceDir) existing.workspaceDir = workspaceDir;
      this.save();
      return existing;
    }

    const session: SessionInfo = {
      id,
      title: title || "New session",
      createdAt: now,
      lastUsedAt: now,
      workspaceDir,
    };
    this.sessions.unshift(session);
    this.save();
    return session;
  }

  /** Store the agent's conversation ID (e.g. Claude CLI session_id) for a session. */
  setAgentSessionId(id: string, agentSessionId: string): void {
    const session = this.sessions.find((s) => s.id === id);
    if (session) {
      session.agentSessionId = agentSessionId;
      this.save();
    }
  }

  /** Cache the origin remote URL for a session. */
  setRemoteUrl(id: string, remoteUrl: string | undefined): void {
    const session = this.sessions.find((s) => s.id === id);
    if (session) {
      session.remoteUrl = remoteUrl;
      this.save();
    }
  }

  /** Rename a session. Returns the updated session, or null if not found. */
  rename(id: string, title: string): SessionInfo | null {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.title = title;
    this.save();
    return session;
  }

  /** Archive a session (hide from list, preserve all data). */
  archive(id: string): boolean {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return false;
    session.archived = true;
    this.save();
    return true;
  }

  /** Delete a session by id. */
  delete(id: string): boolean {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.sessions.splice(idx, 1);
    this.save();
    return true;
  }

  /** Find all sessions whose parentSessionId matches the given id. */
  getChildren(parentId: string): SessionInfo[] {
    return this.sessions.filter(
      (s) => s.parentSessionId === parentId && s.archived !== true,
    );
  }

  /** Set worktree-specific fields on a session. */
  setWorktreeInfo(
    id: string,
    info: { parentSessionId: string; branch: string; sessionType: "worktree" },
  ): void {
    const session = this.sessions.find((s) => s.id === id);
    if (session) {
      session.parentSessionId = info.parentSessionId;
      session.branch = info.branch;
      session.sessionType = info.sessionType;
      this.save();
    }
  }
}
