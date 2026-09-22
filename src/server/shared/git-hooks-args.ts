// The argv half of the hooks guard, kept free of simple-git so build tooling
// (vite.config.ts) can disable hooks without importing a git library.

// /dev/null/<hook> cannot resolve, regardless of the hook name.
export const HOOKS_DISABLED_PATH = "/dev/null";
export const HOOKS_DISABLED_CONFIG = `core.hooksPath=${HOOKS_DISABLED_PATH}`;
export const GIT_HOOKS_DISABLED_ARGS: readonly string[] = ["-c", HOOKS_DISABLED_CONFIG];

export function gitArgsWithHooksDisabled(args: readonly string[]): string[] {
  return [...GIT_HOOKS_DISABLED_ARGS, ...args];
}

/**
 * The deliberate opposite, for docs/266-orchestrator-git-trust-boundary E4
 * (req 9): one invocation that lets the project's own hooks run. It adds
 * nothing — leaving the override off IS the change — and exists so the call
 * site names its intent and `git-hooks-guard-coverage.test.ts` can census it.
 * Only a git that has already dropped root may use it.
 */
export function gitArgsWithProjectHooks(args: readonly string[]): string[] {
  return [...args];
}
