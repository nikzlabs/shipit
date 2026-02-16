import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BranchCheckpoint, ConversationBranch, WsChatHistoryMessage } from "./types.js";

const DEFAULT_BRANCHES_DIR = path.join("/workspace", ".vibe-branches");
const DEFAULT_BRANCHES_FILE = path.join(DEFAULT_BRANCHES_DIR, "branches.json");

interface BranchStore {
  branches: ConversationBranch[];
  activeBranchId: string;
}

export interface BranchSwitchResult {
  branch: ConversationBranch;
  commitHash?: string;
  messages: WsChatHistoryMessage[];
}

/**
 * Persists conversation branches/checkpoints for a workspace.
 */
export class BranchManager {
  private readonly branchesFile: string;
  private store: BranchStore;

  constructor(branchesFile?: string) {
    this.branchesFile = branchesFile ?? DEFAULT_BRANCHES_FILE;
    this.store = this.load();
  }

  private createDefaultStore(): BranchStore {
    const mainBranch: ConversationBranch = {
      id: randomUUID(),
      name: "main",
      sessionId: "",
      checkpoints: [],
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    const initial: BranchStore = {
      branches: [mainBranch],
      activeBranchId: mainBranch.id,
    };
    this.save(initial);
    return initial;
  }

  private normalizeStore(branches: ConversationBranch[], activeBranchId: string): BranchStore {
    if (branches.length === 0) return this.createDefaultStore();

    const normalized = branches.map((branch) => ({
      ...branch,
      createdAt: branch.createdAt || new Date().toISOString(),
      checkpoints: (Array.isArray(branch.checkpoints) ? branch.checkpoints : []).map((checkpoint) => ({
        ...checkpoint,
        messages: Array.isArray(checkpoint.messages) ? checkpoint.messages : [],
      })),
      isActive: branch.id === activeBranchId,
    }));

    const hasActive = normalized.some((branch) => branch.id === activeBranchId);
    if (!hasActive) {
      normalized[0].isActive = true;
      return { branches: normalized, activeBranchId: normalized[0].id };
    }

    return { branches: normalized, activeBranchId };
  }

  private load(): BranchStore {
    try {
      if (fs.existsSync(this.branchesFile)) {
        const raw = fs.readFileSync(this.branchesFile, "utf-8");
        const parsed = JSON.parse(raw) as Partial<BranchStore>;
        if (Array.isArray(parsed.branches) && typeof parsed.activeBranchId === "string") {
          return this.normalizeStore(parsed.branches, parsed.activeBranchId);
        }
      }
    } catch {
      // Fall through to default store
    }
    return this.createDefaultStore();
  }

  private save(store = this.store): void {
    try {
      const dir = path.dirname(this.branchesFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.branchesFile, JSON.stringify(store, null, 2));
    } catch (err) {
      console.error("[branches] failed to save:", err instanceof Error ? err.message : String(err));
    }
  }

  private cloneBranch(branch: ConversationBranch): ConversationBranch {
    return {
      ...branch,
      checkpoints: branch.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        messages: checkpoint.messages ? [...checkpoint.messages] : [],
      })),
    };
  }

  private getActiveBranchRef(): ConversationBranch {
    const branch = this.store.branches.find((item) => item.id === this.store.activeBranchId);
    if (!branch) {
      throw new Error("No active branch found");
    }
    return branch;
  }

  getActiveBranch(): ConversationBranch {
    return this.cloneBranch(this.getActiveBranchRef());
  }

  listBranches(): { branches: ConversationBranch[]; activeBranchId: string } {
    return {
      branches: this.store.branches.map((branch) => this.cloneBranch(branch)),
      activeBranchId: this.store.activeBranchId,
    };
  }

  createCheckpoint(
    sessionId: string,
    messageIndex: number,
    commitHash: string,
    messages: WsChatHistoryMessage[],
    label?: string,
  ): BranchCheckpoint {
    const active = this.getActiveBranchRef();
    if (!active.sessionId) {
      active.sessionId = sessionId;
    }

    const checkpoint: BranchCheckpoint = {
      id: randomUUID(),
      sessionId,
      messageIndex,
      commitHash,
      createdAt: new Date().toISOString(),
      label,
      messages: [...messages],
    };

    active.checkpoints.push(checkpoint);
    this.save();
    return { ...checkpoint, messages: [...checkpoint.messages] };
  }

  branchFromCheckpoint(checkpointId: string, branchName?: string): BranchSwitchResult | null {
    const sourceBranch = this.store.branches.find((branch) =>
      branch.checkpoints.some((checkpoint) => checkpoint.id === checkpointId),
    );
    if (!sourceBranch) return null;

    const checkpoint = sourceBranch.checkpoints.find((item) => item.id === checkpointId);
    if (!checkpoint) return null;

    const newBranch: ConversationBranch = {
      id: randomUUID(),
      parentCheckpointId: checkpoint.id,
      sessionId: "",
      name: branchName?.trim() || `Branch ${this.store.branches.length}`,
      checkpoints: [
        {
          ...checkpoint,
          messages: [...checkpoint.messages],
        },
      ],
      isActive: true,
      createdAt: new Date().toISOString(),
    };

    this.store.branches.forEach((branch) => {
      branch.isActive = false;
    });
    this.store.activeBranchId = newBranch.id;
    this.store.branches.push(newBranch);
    this.save();

    return {
      branch: this.cloneBranch(newBranch),
      commitHash: checkpoint.commitHash,
      messages: [...checkpoint.messages],
    };
  }

  setActiveBranchSessionId(sessionId: string): void {
    const active = this.getActiveBranchRef();
    active.sessionId = sessionId;
    this.save();
  }

  switchBranch(branchId: string): BranchSwitchResult | null {
    const target = this.store.branches.find((branch) => branch.id === branchId);
    if (!target) return null;

    this.store.branches.forEach((branch) => {
      branch.isActive = branch.id === branchId;
    });
    this.store.activeBranchId = branchId;

    const latest = target.checkpoints[target.checkpoints.length - 1];
    this.save();

    return {
      branch: this.cloneBranch(target),
      commitHash: latest?.commitHash,
      messages: latest?.messages ? [...latest.messages] : [],
    };
  }
}
