
import type { FastifyInstance } from "fastify";
import os from "node:os";
import path from "node:path";
import type { FileWatcher } from "./file-watcher.js";
import type { WorkerSSEEvent } from "./sse-broadcaster.js";
import { scanFileTree } from "../shared/file-tree.js";
import { scanSkillsDir } from "../shared/skill-scan.js";

export interface FileWatcherControllerDeps {
  createFileWatcher: () => FileWatcher;
  workspaceDir: string;
  broadcast: (event: WorkerSSEEvent) => void;
}

export class FileWatcherController {
  private fileWatcher: FileWatcher | null = null;

  constructor(private readonly deps: FileWatcherControllerDeps) {}

  registerRoutes(app: FastifyInstance): void {
    app.post("/files/watch", async () => {
      if (this.fileWatcher) {
        return { watching: true, existing: true };
      }
      this.fileWatcher = this.deps.createFileWatcher();
      this.wireFileWatcherEvents(this.fileWatcher);
      this.fileWatcher.start(this.deps.workspaceDir);
      return { watching: true };
    });

    app.post("/files/unwatch", async () => {
      if (this.fileWatcher) {
        this.fileWatcher.stop();
        this.fileWatcher.removeAllListeners();
        this.fileWatcher = null;
      }
      return { stopped: true };
    });

    app.get("/files/tree", async () => {
      const tree = await scanFileTree(this.deps.workspaceDir);
      return { tree };
    });

    app.get("/codex/skills", async () => {
      const skillsDir = path.join(os.homedir(), ".codex", "skills");
      const skills = await scanSkillsDir(skillsDir, "bundled");
      skills.sort((a, b) => a.name.localeCompare(b.name));
      return { skills };
    });
  }

  stop(): void {
    if (this.fileWatcher) {
      this.fileWatcher.stop();
      this.fileWatcher.removeAllListeners();
      this.fileWatcher = null;
    }
  }

  private wireFileWatcherEvents(watcher: FileWatcher): void {
    watcher.on("changes", (paths: string[]) => {
      this.deps.broadcast({ type: "file_changes", data: { paths } });
    });
  }
}
