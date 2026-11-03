
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
  /** Also watched; its changes are reported as absolute paths (`/persist/notes.md`). */
  persistDir?: string;
  broadcast: (event: WorkerSSEEvent) => void;
}

export class FileWatcherController {
  private fileWatcher: FileWatcher | null = null;
  private persistWatcher: FileWatcher | null = null;

  constructor(private readonly deps: FileWatcherControllerDeps) {}

  registerRoutes(app: FastifyInstance): void {
    app.post("/files/watch", async () => {
      if (this.fileWatcher) {
        return { watching: true, existing: true };
      }
      this.fileWatcher = this.deps.createFileWatcher();
      this.wireFileWatcherEvents(this.fileWatcher);
      this.fileWatcher.start(this.deps.workspaceDir);
      const { persistDir } = this.deps;
      if (persistDir) {
        this.persistWatcher = this.deps.createFileWatcher();
        this.wireFileWatcherEvents(this.persistWatcher, (rel) => path.posix.join(persistDir, rel));
        this.persistWatcher.start(persistDir);
      }
      return { watching: true };
    });

    app.post("/files/unwatch", async () => {
      this.stop();
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
    for (const watcher of [this.fileWatcher, this.persistWatcher]) {
      watcher?.stop();
      watcher?.removeAllListeners();
    }
    this.fileWatcher = null;
    this.persistWatcher = null;
  }

  private wireFileWatcherEvents(watcher: FileWatcher, toReported: (rel: string) => string = (rel) => rel): void {
    watcher.on("changes", (paths: string[]) => {
      this.deps.broadcast({ type: "file_changes", data: { paths: paths.map(toReported) } });
    });
  }
}
