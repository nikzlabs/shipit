import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * A checkpoint is a snapshot of conversation + git state at a specific point.
 * Users can branch from checkpoints to explore alternative approaches.
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
 * A branch represents a divergent conversation path from a checkpoint.
 * Each branch has its own conversation history and Claude CLI session.
 */
export interface Branch {
  id: string;
  /** The app session ID this branch belongs to. */
  sessionId: string;
  /** The checkpoint this branch was created from (null for the initial "main" branch). */
  parentCheckpointId: string | null;
  /** Claude CLI agent session ID for this branch (set when the first message is sent). */
  agentSessionId?: string;
  /** Display name. */
  name: string;
  /** Checkpoints within this branch. */
  checkpoints: Checkpoint[];
  /** Whether this branch is the currently active one. */
  isActive: boolean;
  /** Timestamp of creation. */
  createdAt: string;
}

/**
 * Persisted data for a single app session's branches.
 */
interface BranchData {
  branches: Branch[];
  activeBranchId: string;
}

const DEFAULT_BRANCHES_DIR = path.join("/workspace", ".vibe-branches");

/**
 * Manages conversation branching and checkpoints.
 *
 * Each app session can have multiple branches, each with their own
 * checkpoints. Data is persisted to JSON files in the branches directory.
 *
 * @param branchesDir - Directory for branch data files.
 *   Defaults to `/workspace/.vibe-branches`. Override in tests.
 */
export class BranchManager {
  private branchesDir: string;

  constructor(branchesDir?: string) {
    this.branchesDir = branchesDir ?? DEFAULT_BRANCHES_DIR;
    this.ensureDir();
  }

  private ensureDir(): void {
    try {
      if (!fs.existsSync(this.branchesDir)) {
        fs.mkdirSync(this.branchesDir, { recursive: true });
      }
    } catch {
      // Best-effort
    }
  }

  private filePath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.branchesDir, `${safe}.json`);
  }

  private load(sessionId: string): BranchData | null {
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
  private loadOrCreate(sessionId: string): BranchData {
    const data = this.load(sessionId);
    if (data) return data;
    const defaults = this.defaultData(sessionId);
    this.save(sessionId, defaults);
    return defaults;
  }

  private save(sessionId: string, data: BranchData): void {
    try {
      this.ensureDir();
      fs.writeFileSync(this.filePath(sessionId), JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[branches] failed to save:", err instanceof Error ? err.message : String(err));
    }
  }

  /** Create the default branch data with a single "main" branch. */
  private defaultData(sessionId: string): BranchData {
    const mainBranch: Branch = {
      id: crypto.randomUUID(),
      sessionId,
      parentCheckpointId: null,
      name: "main",
      checkpoints: [],
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    return { branches: [mainBranch], activeBranchId: mainBranch.id };
  }

  /**
   * Initialize branch data for a session if it doesn't exist.
   * Returns the initial branch data.
   */
  init(sessionId: string): BranchData {
    return this.loadOrCreate(sessionId);
  }

  /** List all branches for a session. */
  listBranches(sessionId: string): { branches: Branch[]; activeBranchId: string } {
    const data = this.loadOrCreate(sessionId);
    return { branches: data.branches, activeBranchId: data.activeBranchId };
  }

  /** Get the active branch for a session. */
  getActiveBranch(sessionId: string): Branch | undefined {
    const data = this.loadOrCreate(sessionId);
    return data.branches.find((b) => b.id === data.activeBranchId);
  }

  /**
   * Create a checkpoint on the active branch.
   *
   * @param sessionId - App session ID.
   * @param messageIndex - The conversation message index at checkpoint time.
   * @param commitHash - The git commit hash at checkpoint time.
   * @param label - Optional human-readable label.
   * @returns The created checkpoint, or null if no active branch exists.
   */
  createCheckpoint(
    sessionId: string,
    messageIndex: number,
    commitHash: string,
    label?: string,
  ): Checkpoint | null {
    const data = this.loadOrCreate(sessionId);
    const branch = data.branches.find((b) => b.id === data.activeBranchId);
    if (!branch) return null;

    const checkpoint: Checkpoint = {
      id: crypto.randomUUID(),
      sessionId,
      messageIndex,
      commitHash,
      createdAt: new Date().toISOString(),
      label,
    };

    branch.checkpoints.push(checkpoint);
    this.save(sessionId, data);
    return checkpoint;
  }

  /**
   * Get a checkpoint by ID across all branches in a session.
   */
  getCheckpoint(sessionId: string, checkpointId: string): Checkpoint | undefined {
    const data = this.loadOrCreate(sessionId);
    for (const branch of data.branches) {
      const cp = branch.checkpoints.find((c) => c.id === checkpointId);
      if (cp) return cp;
    }
    return undefined;
  }

  /**
   * Create a new branch from a checkpoint. The new branch becomes active.
   *
   * @param sessionId - App session ID.
   * @param checkpointId - The checkpoint to branch from.
   * @returns The new branch, or null if the checkpoint wasn't found.
   */
  branchFrom(sessionId: string, checkpointId: string): Branch | null {
    const data = this.loadOrCreate(sessionId);

    // Find the checkpoint
    let checkpoint: Checkpoint | undefined;
    for (const b of data.branches) {
      checkpoint = b.checkpoints.find((c) => c.id === checkpointId);
      if (checkpoint) break;
    }
    if (!checkpoint) return null;

    // Count existing branches for naming
    const branchNumber = data.branches.length;

    const newBranch: Branch = {
      id: crypto.randomUUID(),
      sessionId,
      parentCheckpointId: checkpointId,
      name: `Branch ${branchNumber}`,
      checkpoints: [],
      isActive: true,
      createdAt: new Date().toISOString(),
    };

    // Deactivate all other branches
    for (const b of data.branches) {
      b.isActive = false;
    }

    data.branches.push(newBranch);
    data.activeBranchId = newBranch.id;
    this.save(sessionId, data);
    return newBranch;
  }

  /**
   * Restore branch data from a snapshot. Used to re-persist data after a git
   * rollback that may have reverted the branch JSON file on disk.
   */
  restore(sessionId: string, snapshot: { branches: Branch[]; activeBranchId: string }): void {
    this.save(sessionId, snapshot);
  }

  /**
   * Switch to an existing branch. Returns the branch, or null if not found.
   */
  switchBranch(sessionId: string, branchId: string): Branch | null {
    const data = this.loadOrCreate(sessionId);
    const branch = data.branches.find((b) => b.id === branchId);
    if (!branch) return null;

    // Deactivate all, activate the target
    for (const b of data.branches) {
      b.isActive = b.id === branchId;
    }
    data.activeBranchId = branchId;
    this.save(sessionId, data);
    return branch;
  }

  /**
   * Set the agent session ID on a branch (called when the CLI reports its session ID).
   */
  setAgentSessionId(sessionId: string, branchId: string, agentSessionId: string): void {
    const data = this.loadOrCreate(sessionId);
    const branch = data.branches.find((b) => b.id === branchId);
    if (branch) {
      branch.agentSessionId = agentSessionId;
      this.save(sessionId, data);
    }
  }

  /**
   * Delete all branch data for a session.
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
