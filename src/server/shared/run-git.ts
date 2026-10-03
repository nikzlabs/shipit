import { spawn } from "node:child_process";
import { killProcessTree } from "./kill-child.js";
import { gitArgsWithHooksDisabled } from "./git-hooks-guard.js";
import { gitSpawnOverridesForTree } from "./git-tree-uid.js";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
  // Replaces process.env so callers can remove inherited credential overrides.
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("git", gitArgsWithHooksDisabled(args), {
        cwd,
        env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        ...gitSpawnOverridesForTree(cwd),
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (buf: string, chunk: Buffer) => (buf + chunk.toString()).slice(-8192);
    proc.stdout.on("data", (c: Buffer) => (stdout = append(stdout, c)));
    proc.stderr.on("data", (c: Buffer) => (stderr = append(stderr, c)));
    // `close` waits on any descendant still holding these pipes, so killing the `git`
    // wrapper alone leaves this promise waiting on the runaway `git lfs` (planning#615).
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc, "SIGKILL", { label: "git" });
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
