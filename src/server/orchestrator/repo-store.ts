import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "../shared/types.js";
import { getErrorMessage } from "../shared/utils.js";

const DEFAULT_REPOS_FILE = path.join("/workspace", ".vibe-repos.json");

/**
 * Manages repo persistence. Stores explicitly added repos in a JSON file
 * so users have a first-class concept of "repo" in the sidebar.
 *
 * Follows the same pattern as SessionManager — JSON file persistence,
 * synchronous in-memory reads, save-on-write.
 *
 * @param reposFile - Path to the JSON file for persistence.
 *   Defaults to `/workspace/.vibe-repos.json`. Override in tests.
 */
export class RepoStore {
  private repos: RepoInfo[] = [];
  private reposFile: string;

  constructor(reposFile?: string) {
    this.reposFile = reposFile ?? DEFAULT_REPOS_FILE;
    this.load();
  }

  /** Load repos from disk. */
  private load(): void {
    try {
      if (fs.existsSync(this.reposFile)) {
        const raw = fs.readFileSync(this.reposFile, "utf-8");
        this.repos = JSON.parse(raw);
      }
    } catch {
      this.repos = [];
    }
  }

  /** Persist repos to disk. */
  private save(): void {
    try {
      fs.writeFileSync(this.reposFile, JSON.stringify(this.repos, null, 2));
    } catch (err) {
      console.error("[repos] failed to save:", getErrorMessage(err));
    }
  }

  /** Add a repo. Sets status to "cloning". Returns the new RepoInfo. */
  add(url: string): RepoInfo {
    const existing = this.repos.find((r) => r.url === url);
    if (existing) {
      existing.lastUsedAt = new Date().toISOString();
      this.save();
      return existing;
    }
    const now = new Date().toISOString();
    const repo: RepoInfo = {
      url,
      addedAt: now,
      lastUsedAt: now,
      status: "cloning",
    };
    this.repos.unshift(repo);
    this.save();
    return repo;
  }

  /** Flip status to "ready" after clone completes. */
  setReady(url: string): void {
    const repo = this.repos.find((r) => r.url === url);
    if (repo) {
      repo.status = "ready";
      this.save();
    }
  }

  /** Store the warm session's ID. */
  setWarmSessionId(url: string, sessionId: string | undefined): void {
    const repo = this.repos.find((r) => r.url === url);
    if (repo) {
      repo.warmSessionId = sessionId;
      this.save();
    }
  }

  /** Update lastUsedAt timestamp. */
  touch(url: string): void {
    const repo = this.repos.find((r) => r.url === url);
    if (repo) {
      repo.lastUsedAt = new Date().toISOString();
      this.save();
    }
  }

  /** Remove a repo. Caller is responsible for worktree/session cleanup. */
  remove(url: string): boolean {
    const idx = this.repos.findIndex((r) => r.url === url);
    if (idx === -1) return false;
    this.repos.splice(idx, 1);
    this.save();
    return true;
  }

  /** List all repos sorted by lastUsedAt descending. */
  list(): RepoInfo[] {
    return [...this.repos].sort(
      (a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime(),
    );
  }

  /** Get a single repo by URL. */
  get(url: string): RepoInfo | undefined {
    return this.repos.find((r) => r.url === url);
  }

  /** Check if a repo URL is already tracked. */
  has(url: string): boolean {
    return this.repos.some((r) => r.url === url);
  }

  /** Clear all in-memory repo data (used by full reset). */
  clear(): void {
    this.repos = [];
  }
}
