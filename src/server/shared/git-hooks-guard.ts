// Disable untrusted repository hooks in orchestrator git, not in the session CLI.
// This does not block other config-driven execution such as filters or helpers.
import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";
import { resolveGitTreeUid } from "./git-tree-uid.js";

// /dev/null/<hook> cannot resolve, regardless of the hook name.
export const HOOKS_DISABLED_PATH = "/dev/null";
export const HOOKS_DISABLED_CONFIG = `core.hooksPath=${HOOKS_DISABLED_PATH}`;
export const GIT_HOOKS_DISABLED_ARGS: readonly string[] = ["-c", HOOKS_DISABLED_CONFIG];

export function gitArgsWithHooksDisabled(args: readonly string[]): string[] {
  return [...GIT_HOOKS_DISABLED_ARGS, ...args];
}

export function safeSimpleGit(baseDir?: string, options?: Partial<SimpleGitOptions>): SimpleGit {
  // Last -c wins. GIT_CONFIG_COUNT would trip simple-git's environment guard.
  const config = [...(options?.config ?? []), HOOKS_DISABLED_CONFIG];
  // Ownership is resolved from baseDir, not clone destinations. Clone callers
  // must hand ownership back without chowning shared hardlinked object files.
  const treeUid = options?.spawnOptions ? null : resolveGitTreeUid(baseDir);
  const spawnOptions = options?.spawnOptions
    ?? (treeUid === null ? undefined : { uid: treeUid.uid, gid: treeUid.gid });

  // Required by simple-git even though our hooks path is a fixed character device.
  const unsafe = { ...options?.unsafe, allowUnsafeHooksPath: true };

  const merged = { ...options, config, unsafe, spawnOptions };
  // The options-object form rejects baseDir: undefined.
  // Do not set GIT_CONFIG_GLOBAL via .env(): a later .env() replaces it entirely.
  return baseDir === undefined ? simpleGit(merged) : simpleGit(baseDir, merged);
}
