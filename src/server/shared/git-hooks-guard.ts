// Disable untrusted repository hooks in orchestrator git, not in the session CLI.
// This does not block other config-driven execution such as filters or helpers.
import { simpleGit, type SimpleGit, type SimpleGitOptions } from "simple-git";
import { resolveGitTreeUid } from "./git-tree-uid.js";
import { HOOKS_DISABLED_CONFIG } from "./git-hooks-args.js";

export {
  HOOKS_DISABLED_PATH,
  HOOKS_DISABLED_CONFIG,
  GIT_HOOKS_DISABLED_ARGS,
  gitArgsWithHooksDisabled,
  gitArgsWithProjectHooks,
} from "./git-hooks-args.js";

// simple-git 4 strips every other guarded variable from git's environment and
// throws when .env() supplies one. GIT_CONFIG_GLOBAL and GIT_EDITOR=true are set
// process-wide (git-config.ts).
const SHIPIT_GIT_ENVIRONMENT = new Set([
  "GIT_CONFIG_GLOBAL",
  "GIT_EDITOR",
  "GIT_TERMINAL_PROMPT",
  "GIT_ALLOW_PROTOCOL",
  "GIT_TRACE_REDACT",
]);

// Mirrors simple-git's guard: any GIT_* name plus the non-GIT_ names @simple-git/argv-parser lists.
const GUARDED_NON_GIT_ENV = new Set(["EDITOR", "VISUAL", "PAGER", "PREFIX", "SSH_ASKPASS"]);

export function isEnvBlockedFromGit(name: string): boolean {
  const key = name.trim().toUpperCase();
  const guarded = key.startsWith("GIT_") || GUARDED_NON_GIT_ENV.has(key);
  return guarded && !SHIPIT_GIT_ENVIRONMENT.has(key);
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

  const allowEnvironment = [...SHIPIT_GIT_ENVIRONMENT, ...(options?.allowEnvironment ?? [])];

  const merged = { ...options, config, unsafe, spawnOptions, allowEnvironment };
  // The options-object form rejects baseDir: undefined.
  // Do not set GIT_CONFIG_GLOBAL via .env(): a later .env() replaces it entirely.
  return baseDir === undefined ? simpleGit(merged) : simpleGit(baseDir, merged);
}
