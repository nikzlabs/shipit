/**
 * File-watcher controller — owns the worker's recursive `FileWatcher` and
 * registers the file endpoints (`/files/watch`, `/files/unwatch`,
 * `/files/tree`, `/codex/skills`). Relays debounced change batches over SSE.
 */

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

    // GET /codex/skills — Codex's built-in system skills, scanned from
    // `~/.codex/skills/<name>/SKILL.md` *inside the container*. os.homedir()
    // resolves against the worker's HOME — `/home/shipit` post-migration
    // (docs/150), `/root` in local mode — and the §4 symlink
    // `~/.codex -> /credentials/.codex` makes this reach the right place. It's
    // a container-only path the orchestrator cannot read over the HTTP link.
    // The orchestrator merges these into GET /api/sessions/:id/skills as
    // `source: "bundled"`. See docs/138-skill-invocation (change #5b).
    app.get("/codex/skills", async () => {
      const skillsDir = path.join(os.homedir(), ".codex", "skills");
      const skills = await scanSkillsDir(skillsDir, "bundled");
      skills.sort((a, b) => a.name.localeCompare(b.name));
      return { skills };
    });
  }

  /** Stop watching (worker shutdown). */
  stop(): void {
    if (this.fileWatcher) {
      this.fileWatcher.stop();
      this.fileWatcher.removeAllListeners();
      this.fileWatcher = null;
    }
  }

  /** Wire file watcher events to the SSE stream. */
  private wireFileWatcherEvents(watcher: FileWatcher): void {
    watcher.on("changes", (paths: string[]) => {
      this.deps.broadcast({ type: "file_changes", data: { paths } });
    });
  }
}
