import fs from "node:fs";
import path from "node:path";
import type { SessionInfo } from "../shared/types.js";

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

  /** List all non-archived, non-warm sessions, most recently used first. */
  list(): SessionInfo[] {
    return this.sessions
      .filter((s) => s.archived !== true && s.warm !== true)
      .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
  }

  /** All session IDs including warm and archived — for container lifecycle decisions. */
  allIds(): string[] {
    return this.sessions.map((s) => s.id);
  }

  /** Find a warm (ungraduated) session for a repo URL, excluding a specific ID.
   *  Used to reuse previously-claimed-but-unused sessions instead of creating new ones. */
  findUngraduatedWarm(repoUrl: string, excludeId?: string): SessionInfo | undefined {
    return this.sessions.find((s) =>
      s.warm === true && s.remoteUrl === repoUrl && s.id !== excludeId);
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

  /** Unarchive a session (restore to active list). */
  unarchive(id: string): boolean {
    const session = this.sessions.find((s) => s.id === id);
    if (!session || !session.archived) return false;
    delete session.archived;
    this.save();
    return true;
  }

  /** List all archived sessions, most recently used first. */
  listArchived(): SessionInfo[] {
    return this.sessions
      .filter((s) => s.archived === true)
      .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
  }

  /** List all non-warm sessions (active + archived), most recently used first. */
  listAll(): SessionInfo[] {
    return this.sessions
      .filter((s) => s.warm !== true)
      .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
  }

  /** Clear all in-memory session data (used by full reset). */
  clear(): void {
    this.sessions = [];
  }

  /** Delete a session by id. */
  delete(id: string): boolean {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.sessions.splice(idx, 1);
    this.save();
    return true;
  }

  /** Set or clear the warm flag on a session. */
  setWarm(id: string, warm: boolean): void {
    const session = this.sessions.find((s) => s.id === id);
    if (session) {
      if (warm) {
        session.warm = true;
      } else {
        delete session.warm;
      }
      this.save();
    }
  }

  /** Find all non-archived sessions with the given remote URL. */
  findAllByRemoteUrl(remoteUrl: string): SessionInfo[] {
    return this.sessions.filter(
      (s) => s.remoteUrl === remoteUrl && s.archived !== true,
    );
  }

  /** Set branch and session type on a session. */
  setWorktreeInfo(
    id: string,
    info: { branch: string; sessionType: "standalone" | "worktree" },
  ): void {
    const session = this.sessions.find((s) => s.id === id);
    if (session) {
      session.branch = info.branch;
      session.sessionType = info.sessionType;
      this.save();
    }
  }
}
