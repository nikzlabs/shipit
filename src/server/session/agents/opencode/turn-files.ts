import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const instructionReaders = new Map<string, number>();

export interface OpencodeTurnFiles {
  configPath: string;
  cleanup: () => void;
}

export function writeOpencodeTurnFiles(
  config: Record<string, unknown>,
  scope: { home: string; cwd: string; systemPrompt?: string },
): OpencodeTurnFiles {
  const configPath = path.join(os.tmpdir(), `opencode-config-${randomUUID()}.json`);
  let instructionPath: string | undefined;
  let released = false;
  const cleanup = (): void => {
    if (released) return;
    released = true;
    removeFile(configPath);
    if (!instructionPath) return;
    const readers = (instructionReaders.get(instructionPath) ?? 1) - 1;
    if (readers > 0) instructionReaders.set(instructionPath, readers);
    else {
      instructionReaders.delete(instructionPath);
      removeFile(instructionPath);
    }
  };

  try {
    if (scope.systemPrompt) {
      // OpenCode includes the path in model input. The CLI session id is absent on the first turn.
      const key = createHash("sha256")
        .update(JSON.stringify([path.resolve(scope.home), path.resolve(scope.cwd), scope.systemPrompt]))
        .digest("hex");
      instructionPath = path.join(os.tmpdir(), `opencode-system-prompt-${key}.md`);
      const readers = instructionReaders.get(instructionPath) ?? 0;
      instructionReaders.set(instructionPath, readers + 1);
      // Publish whole content, including when replacing a file left by a crashed worker.
      if (readers === 0) {
        const temporary = `${instructionPath}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temporary, scope.systemPrompt, { mode: 0o600 });
          fs.renameSync(temporary, instructionPath);
        } finally {
          removeFile(temporary);
        }
      }
      config = { ...config, instructions: [instructionPath] };
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    return { configPath, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function removeFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* best-effort teardown */
  }
}
